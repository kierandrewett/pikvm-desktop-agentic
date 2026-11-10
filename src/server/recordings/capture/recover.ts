import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
    assembleStored,
    loadManifest,
    probeVideo,
    rawPathOf,
    RAW_DIR,
    saveManifest,
    storedPathOf,
    type Manifest,
    type SegmentRecord,
} from "./segments";
import type { AudioRole, Reencoder } from "./transcode";
import type { CompactResult } from "./types";

/**
 * Finishes a recording the host lost track of (a restart, a crash) from what its work directory holds: raw segments that were never
 * re-encoded are queued on the shared re-encoder, stored ones are kept, and the stored segments are joined into `outputPath`.
 * The service calls this at start-up for every `*.parts` directory whose recording has no final file.
 *
 * What is lost: a segment ffmpeg was still writing when the host died (fragmented MP4 keeps all but its last two seconds; an
 * unfinalised Matroska is read as far as it goes), and the true gap between segments when the manifest never recorded it.
 */
export async function recoverCapture(options: {
    workDir: string;
    outputPath: string;
    reencoder: Reencoder;
    ffmpegPath?: string;
    ffprobePath?: string;
    log?: (line: string) => void;
}): Promise<{ ok: true; value: CompactResult } | { ok: false; error: string }> {
    const ffmpeg = options.ffmpegPath ?? "ffmpeg";
    const ffprobe = options.ffprobePath ?? "ffprobe";
    const log = options.log ?? (() => undefined);
    try {
        // A host that crashed leaves its ffmpeg running with the last segment open: stop it so that segment is closed.
        await killOrphanFfmpeg(options.workDir);
        const loaded = await loadManifest(options.workDir);
        const manifest: Manifest = loaded ?? {
            version: 1,
            startedAtWall: Date.now(),
            container: "mp4",
            audioTracks: 1,
            hasMicTrack: false,
            segments: [],
            holes: [],
            ended: true,
        };
        const hasMic = manifest.container === "matroska";
        const roles: AudioRole[] = [...(manifest.audioTracks - (hasMic ? 1 : 0) > 0 ? (["target"] as AudioRole[]) : []), ...(hasMic ? (["mic"] as AudioRole[]) : [])];
        let names: string[] = [];
        try {
            names = (await readdir(join(options.workDir, RAW_DIR))).filter((n) => /^seg-\d+\./.test(n)).sort();
        } catch {
            // No raw directory: everything is already stored.
        }
        const byIndex = new Map(manifest.segments.map((s) => [s.index, s]));
        let previousEnd = 0;
        for (const name of names) {
            const index = Number(/^seg-(\d+)\./.exec(name)![1]);
            let record = byIndex.get(index);
            if (!record) {
                const path = join(options.workDir, RAW_DIR, name);
                const size = (await stat(path)).size;
                const media = await probeVideo(ffprobe, path);
                if (media.packets === 0) {
                    await rm(path, { force: true });
                    continue;
                }
                record = { index, name, startMs: previousEnd, endMs: previousEnd + media.durationMs, rawBytes: size, storedBytes: 0, state: "raw" } satisfies SegmentRecord;
                byIndex.set(index, record);
            }
            previousEnd = record.endMs;
        }
        for (const [index, record] of byIndex) {
            if (record.state !== "stored" && record.endMs - record.startMs < 500) {
                await rm(rawPathOf(options.workDir, record), { force: true });
                byIndex.delete(index);
            }
        }
        const records = [...byIndex.values()].sort((a, b) => a.index - b.index);
        const jobs: Promise<void>[] = [];
        for (const record of records) {
            const raw = rawPathOf(options.workDir, record);
            const stored = storedPathOf(options.workDir, record);
            const rawThere = await stat(raw).then(() => true, () => false);
            if (!rawThere) {
                if (record.state === "stored") continue;
                record.state = "failed";
                record.error = "the raw segment is gone and was never stored";
                continue;
            }
            await rm(`${stored}.partial`, { force: true });
            jobs.push(
                options.reencoder
                    .submit({ id: `recover:${options.workDir}:${record.index}`, input: raw, output: stored, audioRoles: roles })
                    .done.then(async (result) => {
                        record.state = "stored";
                        record.storedBytes = result.bytes;
                        await rm(raw, { force: true });
                    })
                    .catch((error: unknown) => {
                        record.state = "failed";
                        record.error = error instanceof Error ? error.message : String(error);
                        log(`[recorder recover] segment ${record.index}: ${record.error}`);
                    }),
            );
        }
        await Promise.all(jobs);
        manifest.segments = records;
        await saveManifest(options.workDir, manifest);
        if (!records.some((r) => r.state === "stored")) return { ok: false, error: "nothing could be recovered" };
        const joined = await assembleStored({ ffmpeg, ffprobe, workDir: options.workDir, outputPath: options.outputPath, segments: records });
        const failed = records.filter((r) => r.state === "failed");
        if (failed.length === 0) await rm(options.workDir, { recursive: true, force: true });
        return {
            ok: true,
            value: { path: options.outputPath, bytes: joined.bytes, durationMs: joined.durationMs, rawBytesFreed: records.reduce((n, r) => n + (r.state === "stored" ? r.rawBytes : 0), 0) },
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Stops an ffmpeg that outlived the host process that started it. ffmpeg reads UDP and never ends by itself, so a crashed host
 * leaves it running with its file open. Matches processes by the work directory in their command line (Linux /proc only). Returns how
 * many it signalled. SIGINT first so the open segment is finalised, SIGKILL after `graceMs`.
 */
export async function killOrphanFfmpeg(workDir: string, graceMs = 5000): Promise<number> {
    const needle = join(workDir, RAW_DIR);
    const found: number[] = [];
    let entries: string[] = [];
    try {
        entries = await readdir("/proc");
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
        try {
            const cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).replace(/\0/g, " ");
            if (/ffmpeg/.test(cmdline) && cmdline.includes(needle)) found.push(Number(entry));
        } catch {
            // The process went away, or is not ours to read.
        }
    }
    for (const pid of found) {
        try {
            process.kill(pid, "SIGINT");
        } catch {
            // Already gone.
        }
    }
    if (found.length === 0) return 0;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && found.some((pid) => alive(pid))) {
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 100);
        await tick.promise;
    }
    for (const pid of found) {
        if (!alive(pid)) continue;
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Gone between the check and the kill.
        }
    }
    return found.length;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
