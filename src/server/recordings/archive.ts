import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { finished } from "node:stream/promises";
import type { RecordingArchiveSummary } from "@pikvm/contracts/recordings";
import type { ArchiveMeta, RecordingStore } from "./store";

/**
 * A second copy of every recording's file, kept in a folder the operator names (`PIKVM_RECORDINGS_ARCHIVE_DIR`, typically a share
 * on another machine). The host copies each file once it is ready, checks the copy's size and SHA-256, and only then lets the
 * host delete its own file under retention or to stay under the disk limit. The host never deletes an archive copy.
 *
 * Each recording is copied when it is ready. With `PIKVM_RECORDINGS_ARCHIVE_BACKFILL` set, every recording the host still holds
 * (even one made before the archive was turned on) is copied too; without it only recordings made while the archive was on are
 * covered. Copies run one at a time, in the background, and a failed copy is retried with a growing pause.
 */

export interface ArchiveSettings {
    /** The folder the copies go to, or null: the archive is off. */
    dir: string | null;
    /** Copy the recordings the host already holds, not only the ones made while the archive is on. */
    backfill: boolean;
}

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];

export function archiveFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    log: (line: string) => void = (line) => console.warn(line),
): ArchiveSettings {
    const dir = (env["PIKVM_RECORDINGS_ARCHIVE_DIR"] ?? "").trim();
    if (dir !== "" && !isAbsolute(dir)) {
        log(`[recordings] PIKVM_RECORDINGS_ARCHIVE_DIR=${dir} is not an absolute path; the archive is off`);
        return { dir: null, backfill: false };
    }
    const raw = (env["PIKVM_RECORDINGS_ARCHIVE_BACKFILL"] ?? "").trim().toLowerCase();
    if (raw !== "" && !TRUE_VALUES.includes(raw) && !FALSE_VALUES.includes(raw)) {
        log(`[recordings] PIKVM_RECORDINGS_ARCHIVE_BACKFILL=${raw} is not a valid value; backfill is off`);
    }
    return { dir: dir === "" ? null : dir, backfill: TRUE_VALUES.includes(raw) };
}

/** The part of the store the archive uses. */
export type ArchiveStore = Pick<RecordingStore, "has" | "ids" | "status" | "bytesOf" | "archiveOf" | "mediaRemoved" | "mediaPath" | "update">;

export interface ArchiveOptions extends ArchiveSettings {
    store: ArchiveStore;
    log: (line: string) => void;
    now?: () => number;
    /** How often the copies are looked for. Default one minute. */
    pumpEveryMs?: number;
}

export interface ArchiveCopies {
    /** Whether an archive is configured. */
    readonly enabled: boolean;
    readonly backfill: boolean;
    /** Starts looking for recordings to copy every minute. */
    start(): void;
    /** Stops: a copy in flight is abandoned (its partial file removed) and nothing new starts. */
    stop(): Promise<void>;
    /** Runs `work` after every copy queued before it, and before any copy queued after it. */
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    /** Copies every recording that is due to be copied, one at a time. Never throws. */
    pump(): Promise<void>;
    /** A recording's file is ready: queues it for a copy when the archive covers it. */
    consider(id: string): void;
    /** Whether the host may delete this recording's file: true when the archive does not cover it, or its copy is verified. */
    mayRemoveMedia(id: string): Promise<boolean>;
    /** The recording is being deleted: a copy of it in flight is abandoned. The copy already in the archive stays. */
    cancel(id: string): void;
    /** How many recordings are copied, waiting, and failing, for the list and Settings. */
    summary(): RecordingArchiveSummary;
}

/** A copy abandoned because the host is stopping or the recording is being deleted: its state is left as it was. */
class Abandoned extends Error {}

const MINUTE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * MINUTE_MS;

/** The pause before the next try after `attempts` failed tries: one minute, doubling, capped at six hours. */
export function backoffMs(attempts: number): number {
    return Math.min(MINUTE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function sha256Of(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

export function createArchive(options: ArchiveOptions): ArchiveCopies {
    const { store, log } = options;
    const root = options.dir;
    const enabled = root !== null;
    const backfill = options.backfill;
    const now = options.now ?? Date.now;
    const active = new Set<string>();
    const abandon = new Set<string>();
    let chain: Promise<unknown> = Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    let stopping = false;

    function exclusive<T>(work: () => Promise<T>): Promise<T> {
        const next = chain.then(work, work);
        chain = next.catch(() => undefined);
        return next;
    }

    /** Streams the source into the partial file, hashing as it goes, and syncs the partial file to disk. */
    async function streamTo(source: string, partial: string, id: string): Promise<{ bytes: number; sha256: string }> {
        const hash = createHash("sha256");
        let bytes = 0;
        const sink = createWriteStream(partial, { mode: 0o600 });
        try {
            for await (const chunk of createReadStream(source)) {
                if (stopping || abandon.has(id)) throw new Abandoned();
                hash.update(chunk);
                bytes += chunk.length;
                if (!sink.write(chunk)) await once(sink, "drain");
            }
            sink.end();
            await finished(sink);
        } catch (error) {
            sink.destroy();
            throw error;
        }
        const handle = await open(partial, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        return { bytes, sha256: hash.digest("hex") };
    }

    /**
     * Copies one recording's file into the archive: streamed to a partial file, checked, then renamed into place.
     * A file already in the archive under the same name is accepted only when it is byte-identical to this copy; anything
     * else there is not ours to replace and is left alone.
     */
    async function copyOne(id: string, meta: ArchiveMeta): Promise<void> {
        const source = store.mediaPath(id);
        const name = basename(source);
        const folder = join(root!, id);
        const dest = join(folder, name);
        const partial = `${dest}.part`;
        const attempts = meta.attempts + 1;
        active.add(id);
        try {
            // The archive folder itself must be there: a missing mount must not be replaced by a folder on the host's own disk.
            const rootInfo = await stat(root!).catch(() => null);
            if (!rootInfo?.isDirectory()) throw new Error(`The archive folder ${root} is not there.`);
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const size = (await stat(source)).size;
            const { bytes, sha256 } = await streamTo(source, partial, id);
            if (bytes !== size) throw new Error(`The recording changed while it was copied (${bytes} of ${size} bytes).`);
            const existing = await stat(dest).catch(() => null);
            if (existing) {
                const identical = existing.size === bytes && (await sha256Of(dest)) === sha256;
                if (!identical) {
                    throw new Error("The archive already holds a different file under this recording's name, so it was left alone.");
                }
                await rm(partial, { force: true });
            } else {
                await rename(partial, dest);
            }
            const check = await stat(dest);
            if (check.size !== bytes || (await sha256Of(dest)) !== sha256) {
                throw new Error("The archive copy does not match the recording it was copied from.");
            }
            await store.update(id, {
                archive: { state: "copied", files: { [name]: { bytes, sha256 } }, copiedAt: now(), attempts, nextAt: null, error: null },
            });
            log(`[recordings] ${id} copied to the archive: ${(bytes / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}...`);
        } catch (error) {
            await rm(partial, { force: true }).catch(() => undefined);
            if (error instanceof Abandoned || !store.has(id)) return;
            const message = messageOf(error);
            log(`[recordings] ${id} could not be copied to the archive (attempt ${attempts}): ${message}`);
            const failed: ArchiveMeta = { state: "failed", files: {}, copiedAt: null, attempts, nextAt: now() + backoffMs(attempts), error: message };
            await store.update(id, { archive: failed }).catch(() => undefined);
        } finally {
            active.delete(id);
            abandon.delete(id);
        }
    }

    async function pumpLocked(): Promise<void> {
        if (!enabled) return;
        for (const id of store.ids()) {
            if (stopping) return;
            if (!store.has(id) || store.mediaRemoved(id)) continue;
            const status = store.status(id);
            if (status === "recording" || status === "finishing" || store.bytesOf(id) === 0) continue;
            try {
                let meta = store.archiveOf(id);
                if (meta === null) {
                    if (!backfill) continue;
                    meta = { state: "pending", files: {}, copiedAt: null, attempts: 0, nextAt: null, error: null };
                    await store.update(id, { archive: meta });
                }
                if (meta.state === "copied" || (meta.nextAt !== null && meta.nextAt > now())) continue;
                await copyOne(id, meta);
            } catch (error) {
                if (store.has(id)) log(`[recordings] ${id}: the archive could not be checked: ${messageOf(error)}`);
            }
        }
    }

    return {
        enabled,
        backfill,

        start() {
            if (!enabled || timer !== undefined) return;
            const every = options.pumpEveryMs ?? MINUTE_MS;
            timer = setInterval(() => {
                exclusive(pumpLocked).catch((error: unknown) => log(`[recordings] archive: ${messageOf(error)}`));
            }, every);
            timer.unref();
        },

        async stop() {
            stopping = true;
            clearInterval(timer);
            timer = undefined;
            for (const id of active) abandon.add(id);
            await chain;
        },

        exclusive,

        pump() {
            return exclusive(pumpLocked);
        },

        consider(id) {
            if (!enabled || !store.has(id) || store.archiveOf(id) !== null) return;
            const meta: ArchiveMeta = { state: "pending", files: {}, copiedAt: null, attempts: 0, nextAt: null, error: null };
            store
                .update(id, { archive: meta })
                .then(() => exclusive(pumpLocked))
                .catch((error: unknown) => log(`[recordings] ${id}: could not queue the archive copy: ${messageOf(error)}`));
        },

        async mayRemoveMedia(id) {
            if (!enabled || !store.has(id)) return true;
            const meta = store.archiveOf(id);
            if (meta === null) return !backfill;
            if (meta.state !== "copied") return false;
            const name = basename(store.mediaPath(id));
            const file = meta.files[name];
            if (file === undefined) return false;
            const size = await stat(join(root!, id, name)).then(
                (info) => info.size,
                () => -1,
            );
            return size === file.bytes;
        },

        cancel(id) {
            if (active.has(id)) abandon.add(id);
        },

        summary() {
            const summary: RecordingArchiveSummary = { enabled, backfill, copied: 0, pending: 0, failed: 0 };
            if (!enabled) return summary;
            for (const id of store.ids()) {
                const meta = store.archiveOf(id);
                if (meta === null) continue;
                if (meta.state === "copied") summary.copied += 1;
                else if (meta.state === "failed") summary.failed += 1;
                else summary.pending += 1;
            }
            return summary;
        },
    };
}
