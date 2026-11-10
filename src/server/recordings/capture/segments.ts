import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureHole, DiskUsage } from "./types";

/**
 * The on-disk life of one recording: `workDir/raw/seg-N.{mp4,mkv}` (1080p passthrough, closed by ffmpeg's segment muxer),
 * `workDir/stored/seg-N.mp4` (the compact re-encode of the same span), a manifest, and finally the one file at `outputPath`.
 *
 * The timeline is the capture's own, in milliseconds from its first video frame, so a hole (a reconnect) and a restarted ffmpeg keep
 * their real length. The final file is the stored segments joined with ffmpeg's concat demuxer (`-c copy`, nothing re-encoded), each
 * entry given the explicit `duration` that places the next one where it really began; a hole between two segments stays a hole.
 */

export type SegmentState = "raw" | "queued" | "stored" | "failed";

export interface SegmentRecord {
    index: number;
    /** File name inside raw/ (and, with `.mp4`, inside stored/). */
    name: string;
    startMs: number;
    endMs: number;
    rawBytes: number;
    storedBytes: number;
    state: SegmentState;
    error?: string;
}

export interface Manifest {
    version: 1;
    startedAtWall: number;
    container: "mp4" | "matroska";
    audioTracks: number;
    hasMicTrack: boolean;
    segments: SegmentRecord[];
    holes: CaptureHole[];
    ended: boolean;
}

export const RAW_DIR = "raw";
export const STORED_DIR = "stored";
const MANIFEST = "manifest.json";

export function rawPathOf(workDir: string, record: Pick<SegmentRecord, "name">): string {
    return join(workDir, RAW_DIR, record.name);
}

export function storedPathOf(workDir: string, record: Pick<SegmentRecord, "index">): string {
    return join(workDir, STORED_DIR, `seg-${String(record.index).padStart(6, "0")}.mp4`);
}

export async function saveManifest(workDir: string, manifest: Manifest): Promise<void> {
    const temp = join(workDir, `${MANIFEST}.tmp`);
    await writeFile(temp, JSON.stringify(manifest));
    await rename(temp, join(workDir, MANIFEST));
}

export async function loadManifest(workDir: string): Promise<Manifest | null> {
    try {
        const parsed = JSON.parse(await readFile(join(workDir, MANIFEST), "utf8")) as Manifest;
        return parsed.version === 1 ? parsed : null;
    } catch {
        return null;
    }
}

async function directoryBytes(dir: string): Promise<number> {
    let total = 0;
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return 0;
    }
    for (const name of names) {
        if (name.endsWith(".sdp")) continue;
        try {
            total += (await stat(join(dir, name))).size;
        } catch {
            // Removed between the listing and the stat: it no longer counts.
        }
    }
    return total;
}

/** What the recording takes on disk right now: raw segments (including the one being written) and stored ones. */
export async function diskUsageOf(workDir: string): Promise<DiskUsage> {
    const [rawBytes, storedBytes] = await Promise.all([directoryBytes(join(workDir, RAW_DIR)), directoryBytes(join(workDir, STORED_DIR))]);
    return { rawBytes, storedBytes, totalBytes: rawBytes + storedBytes };
}

export async function ensureDirs(workDir: string): Promise<void> {
    await mkdir(join(workDir, RAW_DIR), { recursive: true });
    await mkdir(join(workDir, STORED_DIR), { recursive: true });
}

/** Seconds of a media file, or null when ffprobe cannot read it. */
export function probeDurationMs(ffprobe: string, file: string): Promise<number | null> {
    const { promise, resolve } = Promise.withResolvers<number | null>();
    execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration,start_time", "-of", "default=nw=1", file], { timeout: 60_000 }, (error, stdout) => {
        const field = (name: string): number => Number(new RegExp(`^${name}=(.*)$`, "m").exec(String(stdout))?.[1]);
        const seconds = field("duration") - Math.max(0, field("start_time") || 0);
        resolve(error || !Number.isFinite(seconds) || seconds <= 0 ? null : Math.round(seconds * 1000));
    });
    return promise;
}

/**
 * Video packets in a file and the span they cover, read packet by packet: works on an unfinalised Matroska (no duration) and tells a
 * segment that holds no frame (ffmpeg was killed right after opening it) from one worth keeping.
 */
export function probeVideo(ffprobe: string, file: string): Promise<{ packets: number; durationMs: number }> {
    const { promise, resolve } = Promise.withResolvers<{ packets: number; durationMs: number }>();
    execFile(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { timeout: 120_000, maxBuffer: 1 << 27 }, (error, stdout) => {
        const times = String(stdout).split("\n").map(Number).filter((n) => Number.isFinite(n) && String(n) !== "");
        if (error && times.length === 0) return resolve({ packets: 0, durationMs: 0 });
        const first = Math.min(...times);
        const last = Math.max(...times);
        resolve({ packets: times.length, durationMs: times.length ? Math.round((last - first + 1 / 30) * 1000) : 0 });
    });
    return promise;
}

function run(file: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stderr: string }>();
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
    });
    child.once("error", (error) => resolve({ code: null, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stderr }));
    return promise;
}

export interface AssembleResult {
    bytes: number;
    durationMs: number;
    joined: number;
}

/**
 * Joins the stored segments into `outputPath`. One segment is simply renamed into place. Several go through the concat demuxer with
 * `-c copy` and `+faststart`, written beside the target and renamed, so a crash never leaves a half-written final file.
 */
export async function assembleStored(options: {
    ffmpeg: string;
    ffprobe: string;
    workDir: string;
    outputPath: string;
    segments: SegmentRecord[];
}): Promise<AssembleResult> {
    const stored = options.segments.filter((s) => s.state === "stored").sort((a, b) => a.index - b.index);
    if (stored.length === 0) throw new Error("no stored segment to assemble");
    const first = storedPathOf(options.workDir, stored[0]!);
    if (stored.length === 1) {
        await rename(first, options.outputPath);
        const size = (await stat(options.outputPath)).size;
        return { bytes: size, durationMs: (await probeDurationMs(options.ffprobe, options.outputPath)) ?? 0, joined: 1 };
    }
    const lines: string[] = ["ffconcat version 1.0"];
    for (let i = 0; i < stored.length; i += 1) {
        const segment = stored[i]!;
        const path = storedPathOf(options.workDir, segment);
        lines.push(`file '${path.replace(/'/g, "'\\''")}'`);
        const next = stored[i + 1];
        if (next) {
            const real = (await probeDurationMs(options.ffprobe, path)) ?? 0;
            // Where the next segment really began, but never earlier than this one's own length: overlap would break the timestamps.
            const span = Math.max(real, next.startMs - segment.startMs);
            lines.push(`duration ${(span / 1000).toFixed(3)}`);
        }
    }
    const listPath = join(options.workDir, "concat.txt");
    await writeFile(listPath, `${lines.join("\n")}\n`);
    const partial = `${options.outputPath}.partial`;
    const result = await run(options.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0",
        "-c", "copy", "-movflags", "+faststart", "-f", "mp4", partial,
    ]);
    if (result.code !== 0) {
        await rm(partial, { force: true });
        throw new Error(`joining the stored segments failed: ${result.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    }
    await rename(partial, options.outputPath);
    await rm(listPath, { force: true });
    return { bytes: (await stat(options.outputPath)).size, durationMs: (await probeDurationMs(options.ffprobe, options.outputPath)) ?? 0, joined: stored.length };
}
