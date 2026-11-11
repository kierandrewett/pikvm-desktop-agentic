/**
 * The recordings archive, against a real temporary folder and an in-memory stand-in for the store.
 *
 * The archive only ever touches the store through a handful of methods, so the stand-in keeps just those. The point of
 * these tests is what reaches the disk: a copy is verified before the host may delete its own file, a copy that fails is
 * retried with a growing pause, and a file the archive already holds under the same name is never overwritten.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveFromEnv, backoffMs, createArchive, type ArchiveStore } from "../src/server/recordings/archive";
import type { ArchiveMeta } from "../src/server/recordings/store";

interface Fake {
    status: string;
    bytes: number;
    archive: ArchiveMeta | null;
    mediaRemoved: boolean;
}

/** A store with the methods the archive calls, over `hostDir/<id>/video.mkv`. */
function fakeStore(hostDir: string, recordings: Record<string, Fake>): ArchiveStore {
    const store = {
        has: (id: string) => id in recordings,
        ids: () => Object.keys(recordings),
        status: (id: string) => recordings[id]!.status,
        bytesOf: (id: string) => recordings[id]!.bytes,
        archiveOf: (id: string) => recordings[id]!.archive,
        mediaRemoved: (id: string) => recordings[id]!.mediaRemoved,
        mediaPath: (id: string) => join(hostDir, id, "video.mkv"),
        update: async (id: string, patch: { archive?: ArchiveMeta | null }) => {
            recordings[id]!.archive = patch.archive ?? null;
            return {};
        },
    };
    return store as unknown as ArchiveStore;
}

function setup(recordings: Record<string, Fake>, options: { backfill?: boolean } = {}) {
    const base = mkdtempSync(join(tmpdir(), "pikvm-archive-test-"));
    const hostDir = join(base, "host");
    const archiveDir = join(base, "archive");
    mkdirSync(archiveDir, { recursive: true });
    for (const id of Object.keys(recordings)) {
        mkdirSync(join(hostDir, id), { recursive: true });
        writeFileSync(join(hostDir, id, "video.mkv"), `video of ${id}`);
    }
    const logs: string[] = [];
    let clock = 1_000_000;
    const archive = createArchive({
        store: fakeStore(hostDir, recordings),
        dir: archiveDir,
        backfill: options.backfill ?? false,
        log: (line) => logs.push(line),
        now: () => clock,
    });
    const advance = (ms: number) => {
        clock += ms;
    };
    return { archive, archiveDir, logs, advance, teardown: () => rmSync(base, { recursive: true, force: true }) };
}

const idle = (overrides: Partial<Fake> = {}): Fake => ({ status: "ready", bytes: 13, archive: null, mediaRemoved: false, ...overrides });

test("backoffMs: one minute, doubling, capped at six hours", () => {
    assert.equal(backoffMs(1), 60_000);
    assert.equal(backoffMs(2), 120_000);
    assert.equal(backoffMs(3), 240_000);
    assert.equal(backoffMs(20), 6 * 60 * 60_000);
});

test("archiveFromEnv: a relative folder turns the archive off, and only true values enable backfill", () => {
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    assert.deepEqual(archiveFromEnv({ PIKVM_RECORDINGS_ARCHIVE_DIR: "relative/dir" }, log), { dir: null, backfill: false });
    assert.equal(logs.length, 1);
    assert.deepEqual(archiveFromEnv({ PIKVM_RECORDINGS_ARCHIVE_DIR: "/mnt/share", PIKVM_RECORDINGS_ARCHIVE_BACKFILL: "yes" }, log), {
        dir: "/mnt/share",
        backfill: true,
    });
    assert.deepEqual(archiveFromEnv({ PIKVM_RECORDINGS_ARCHIVE_DIR: "/mnt/share", PIKVM_RECORDINGS_ARCHIVE_BACKFILL: "maybe" }, log), {
        dir: "/mnt/share",
        backfill: false,
    });
    assert.equal(logs.length, 2);
});

test("a recording made while the archive is on is copied and verified, and only then may the host delete its file", async () => {
    const recordings = { b2: idle() };
    const t = setup(recordings);
    try {
        t.archive.consider("b2");
        await t.archive.pump();
        const meta = recordings["b2"]!.archive;
        assert.equal(meta?.state, "copied");
        assert.equal(readFileSync(join(t.archiveDir, "b2", "video.mkv"), "utf8"), "video of b2");
        assert.equal(await t.archive.mayRemoveMedia("b2"), true, "the copy matches the file's size");
        recordings["b2"]!.archive = { ...meta!, files: { "video.mkv": { bytes: 999, sha256: "x" } } };
        assert.equal(await t.archive.mayRemoveMedia("b2"), false, "a copy whose size disagrees keeps the host's file");
        assert.deepEqual(t.archive.summary(), { enabled: true, backfill: false, copied: 1, pending: 0, failed: 0 });
    } finally {
        t.teardown();
    }
});

test("without backfill, a recording made before the archive was on is not covered, so the host may delete it", async () => {
    const recordings = { g7: idle() };
    const t = setup(recordings);
    try {
        await t.archive.pump();
        assert.equal(recordings["g7"]!.archive, null);
        assert.equal(await t.archive.mayRemoveMedia("g7"), true);
    } finally {
        t.teardown();
    }
});

test("with backfill on, a recording the archive has not seen yet is copied, and is kept until it is", async () => {
    const recordings = { c3: idle() };
    const t = setup(recordings, { backfill: true });
    try {
        assert.equal(await t.archive.mayRemoveMedia("c3"), false, "backfill covers it, so it is not yet safe to delete");
        await t.archive.pump();
        assert.equal(recordings["c3"]!.archive?.state, "copied");
        assert.equal(await t.archive.mayRemoveMedia("c3"), true);
    } finally {
        t.teardown();
    }
});

test("a failed copy is retried with a growing pause and keeps its reason, and never releases the host's file", async () => {
    const recordings = { d4: idle() };
    const t = setup(recordings);
    rmSync(t.archiveDir, { recursive: true, force: true });
    try {
        t.archive.consider("d4");
        await t.archive.pump();
        const first = recordings["d4"]!.archive!;
        assert.equal(first.state, "failed");
        assert.equal(first.attempts, 1);
        assert.match(first.error ?? "", /archive folder .* is not there/);
        assert.equal(first.nextAt, 1_000_000 + 60_000);
        await t.archive.pump();
        assert.equal(recordings["d4"]!.archive!.attempts, 1, "not due yet, so no new attempt");
        t.advance(60_000);
        await t.archive.pump();
        assert.equal(recordings["d4"]!.archive!.attempts, 2);
        assert.equal(recordings["d4"]!.archive!.nextAt, 1_000_000 + 60_000 + 120_000);
        assert.equal(await t.archive.mayRemoveMedia("d4"), false);
    } finally {
        t.teardown();
    }
});

test("a different file already in the archive under the same name is left alone and the copy fails", async () => {
    const recordings = { e5: idle() };
    const t = setup(recordings);
    try {
        mkdirSync(join(t.archiveDir, "e5"), { recursive: true });
        writeFileSync(join(t.archiveDir, "e5", "video.mkv"), "someone else's file");
        t.archive.consider("e5");
        await t.archive.pump();
        assert.equal(recordings["e5"]!.archive?.state, "failed");
        assert.match(recordings["e5"]!.archive?.error ?? "", /left alone/);
        assert.equal(readFileSync(join(t.archiveDir, "e5", "video.mkv"), "utf8"), "someone else's file");
    } finally {
        t.teardown();
    }
});

test("a recording whose file the host already removed is not copied again", async () => {
    const recordings = { f6: idle({ mediaRemoved: true }) };
    const t = setup(recordings, { backfill: true });
    try {
        await t.archive.pump();
        assert.equal(recordings["f6"]!.archive, null);
    } finally {
        t.teardown();
    }
});
