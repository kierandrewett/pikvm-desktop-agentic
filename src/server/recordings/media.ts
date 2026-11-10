import { execFile } from "node:child_process";

/**
 * What the host asks ffmpeg's tools about a recording. ffprobe comes with ffmpeg; the image installs both.
 * Nothing here decodes audio: that is the transcriber's worker.
 */

export interface MediaFacts {
    hasVideo: boolean;
    hasAudio: boolean;
    /** Channels of the first audio stream, 0 without one. */
    audioChannels: number;
    /** Seconds, when the container says (a browser's live WebM often does not). */
    durationSeconds: number | null;
}

type Ran = { ok: true; stdout: string } | { ok: false; missing: boolean; message: string };

function run(file: string, args: string[], timeoutMs: number): Promise<Ran> {
    const { promise, resolve } = Promise.withResolvers<Ran>();
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ ok: false, missing, message: (String(stderr).trim().split("\n").pop() ?? "") || error.message });
    });
    return promise;
}

let toolsCheck: { at: number; value: string | null } | null = null;

/** Null when ffmpeg and ffprobe both run, else the reason they cannot. Cached for half a minute. */
export async function ffmpegProblem(): Promise<string | null> {
    if (toolsCheck && Date.now() - toolsCheck.at < 30_000) return toolsCheck.value;
    let value: string | null = null;
    for (const tool of ["ffmpeg", "ffprobe"]) {
        const result = await run(tool, ["-version"], 10_000);
        if (!result.ok) {
            value = result.missing ? `${tool} is not installed on this host.` : `${tool} does not run: ${result.message}`;
            break;
        }
    }
    toolsCheck = { at: Date.now(), value };
    return value;
}

/**
 * Reads the container's streams. `null` means ffprobe is not installed (nothing can be said, so the file is not condemned);
 * a rejection means the file is not media ffprobe can read.
 */
export async function probeMedia(file: string): Promise<MediaFacts | null> {
    const result = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,channels:format=duration", "-of", "json", file], 30_000);
    if (!result.ok) {
        if (result.missing) return null;
        throw new Error(result.message || "ffprobe could not read the file");
    }
    const parsed = JSON.parse(result.stdout) as { streams?: { codec_type?: string; channels?: number }[]; format?: { duration?: string } };
    const streams = parsed.streams ?? [];
    if (streams.length === 0) throw new Error("the file has no video or audio stream");
    const audio = streams.find((s) => s.codec_type === "audio");
    const duration = Number(parsed.format?.duration);
    return {
        hasVideo: streams.some((s) => s.codec_type === "video"),
        hasAudio: audio !== undefined,
        audioChannels: audio?.channels ?? 0,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
}
