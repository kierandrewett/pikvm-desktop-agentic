import { spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * One ffmpeg process that turns the three RTP streams (video, the Pi's audio, optionally the microphone) into raw segments, `-c copy`.
 *
 * ffmpeg reads an SDP file whose media lines point at loopback UDP ports this module picks; the capture session sends RTP there.
 * Output goes through ffmpeg's segment muxer, so one process writes a series of closed files with continuous timestamps:
 *  - fragmented MP4 (`+frag_keyframe+empty_moov+default_base_moof`, a fragment every 2 s) when there is no microphone: the file is
 *    playable from the first fragment and a kill loses at most the last two seconds;
 *  - Matroska when there is a second audio track (the spike only proved two tracks in Matroska; an unfinalised Matroska needs a remux).
 * H.264 cannot go in WebM. Segments are cut at the first keyframe after `segmentSeconds`; the session sets that time half a keyframe
 * interval early so the cut falls on the PLI scheduler's keyframe instead of waiting a whole interval for the next one.
 *
 * Stop is SIGINT, and ffmpeg only honours it while packets still flow, so `stop()` keeps sending datagrams until it exits.
 * A process that dies on its own is reported through `exited`; the session decides whether to start another (the next run continues
 * the segment numbering and the session makes the gate wait for a fresh keyframe).
 */

export type RawContainer = "mp4" | "matroska";

export interface FfmpegRunOptions {
    ffmpegPath: string;
    /** The directory the raw segments go to (created). */
    rawDir: string;
    /** The number the first segment of this run gets in its name. */
    startNumber: number;
    audio: boolean;
    mic: boolean;
    container: RawContainer;
    segmentSeconds: number;
    log: (line: string) => void;
    /** A segment was closed. Times are seconds on this run's own clock (0 at its first packet). */
    onSegment: (segment: { name: string; startS: number; endS: number }) => void;
}

export interface FfmpegExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** The last lines ffmpeg wrote to stderr. */
    tail: string[];
}

export interface FfmpegRun {
    readonly pid: number | undefined;
    readonly container: RawContainer;
    send(stream: "video" | "audio" | "mic", rtp: Buffer): void;
    sendRtcp(stream: "video" | "audio" | "mic", rtcp: Buffer): void;
    /** Resolves when the process is gone, however it went. */
    readonly exited: Promise<FfmpegExit>;
    /**
     * SIGINT; a second after `secondSigintAfterMs` (a read blocked on a silent socket needs it); SIGKILL after `killAfterMs`.
     * `clean` is false only when the kill was needed. The caller should keep packets flowing until it returns.
     */
    stop(secondSigintAfterMs?: number, killAfterMs?: number): Promise<{ clean: boolean; exit: FfmpegExit }>;
    readonly stopping: boolean;
}

const PORT_LOW = 30_000;
const PORT_HIGH = 59_000;

function tryBind(port: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = dgram.createSocket({ type: "udp4", recvBufferSize: 0 });
    socket.once("error", () => {
        resolve(false);
        socket.close();
    });
    socket.bind(port, "127.0.0.1", () => {
        socket.close(() => resolve(true));
    });
    return promise;
}

/** An even port whose neighbour (RTCP) is free too. */
async function allocatePair(taken: Set<number>): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const port = PORT_LOW + 2 * Math.floor(Math.random() * ((PORT_HIGH - PORT_LOW) / 2));
        if (taken.has(port)) continue;
        if ((await tryBind(port)) && (await tryBind(port + 1))) {
            taken.add(port);
            return port;
        }
    }
    throw new Error("no free loopback UDP port pair for ffmpeg");
}

export function buildSdp(ports: { video: number; audio?: number; mic?: number }): string {
    const lines = [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=pikvm",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        `m=video ${ports.video} RTP/AVP 96`,
        "a=rtpmap:96 H264/90000",
        "a=fmtp:96 packetization-mode=1",
    ];
    if (ports.audio !== undefined) lines.push(`m=audio ${ports.audio} RTP/AVP 111`, "a=rtpmap:111 opus/48000/2");
    if (ports.mic !== undefined) lines.push(`m=audio ${ports.mic} RTP/AVP 112`, "a=rtpmap:112 opus/48000/2");
    return `${lines.join("\r\n")}\r\n`;
}

export function segmentName(index: number, container: RawContainer): string {
    return `seg-${String(index).padStart(6, "0")}.${container === "mp4" ? "mp4" : "mkv"}`;
}

export async function startFfmpegRun(options: FfmpegRunOptions): Promise<FfmpegRun> {
    await mkdir(options.rawDir, { recursive: true });
    const taken = new Set<number>();
    const ports: { video: number; audio?: number; mic?: number } = { video: await allocatePair(taken) };
    if (options.audio) ports.audio = await allocatePair(taken);
    if (options.mic) ports.mic = await allocatePair(taken);
    const sdpPath = join(options.rawDir, `input-${process.pid}-${ports.video}.sdp`);
    await writeFile(sdpPath, buildSdp(ports));

    const audioTracks = (options.audio ? 1 : 0) + (options.mic ? 1 : 0);
    const maps = ["-map", "0:v:0"];
    for (let i = 0; i < audioTracks; i += 1) maps.push("-map", `0:a:${i}`);
    const titles: string[] = [];
    let a = 0;
    if (options.audio) titles.push(`-metadata:s:a:${a++}`, "title=target");
    if (options.mic) titles.push(`-metadata:s:a:${a++}`, "title=mic");
    const segmentOptions =
        options.container === "mp4" ? ["-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof:frag_duration=2000000"] : [];
    const args = [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,udp,rtp",
        "-analyzeduration",
        "4000000",
        "-probesize",
        "4000000",
        // ffmpeg's default UDP receive buffer (208 KB) overflows when it is starved for a moment on a busy host; a keyframe
        // burst alone is 300 KB. The kernel caps this at net.core.rmem_max.
        "-buffer_size",
        "8388608",
        "-i",
        sdpPath,
        ...maps,
        ...titles,
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        String(options.segmentSeconds),
        "-segment_start_number",
        String(options.startNumber),
        "-segment_format",
        options.container,
        ...segmentOptions,
        "-reset_timestamps",
        "0",
        "-segment_list",
        "pipe:1",
        "-segment_list_type",
        "csv",
        join(options.rawDir, `seg-%06d.${options.container === "mp4" ? "mp4" : "mkv"}`),
    ];
    options.log(`[recorder ffmpeg] ${options.ffmpegPath} ${args.join(" ")}`);
    const child: ChildProcess = spawn(options.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    let lossLogged = 0;
    let stderrBuf = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk;
        let nl: number;
        while ((nl = stderrBuf.search(/[\r\n]/)) >= 0) {
            const line = stderrBuf.slice(0, nl).trim();
            stderrBuf = stderrBuf.slice(nl + 1);
            if (!line) continue;
            tail.push(line);
            // ffmpeg's own view of loss on its loopback sockets: the E2E reads these to tell a starved ffmpeg from a starved Pi stream.
            if (/RTP: missed|max delay reached|Packet corrupt|unaligned|dropped/i.test(line) && lossLogged < 50) {
                lossLogged += 1;
                options.log(`[recorder ffmpeg] ${line}`);
            }
            if (tail.length > 40) tail.shift();
        }
    });
    let stdoutBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            const parts = line.split(",");
            if (parts.length < 3) continue;
            const startS = Number(parts[parts.length - 2]);
            const endS = Number(parts[parts.length - 1]);
            if (!Number.isFinite(startS) || !Number.isFinite(endS)) continue;
            options.onSegment({ name: basename(parts.slice(0, -2).join(",")), startS, endS });
        }
    });
    const exited = Promise.withResolvers<FfmpegExit>();
    let gone = false;
    child.once("error", (error) => {
        tail.push(`spawn failed: ${error.message}`);
        if (!gone) {
            gone = true;
            exited.resolve({ code: null, signal: null, tail: [...tail] });
        }
    });
    child.once("close", (code, signal) => {
        gone = true;
        exited.resolve({ code, signal, tail: [...tail] });
    });

    const out = dgram.createSocket("udp4");
    out.on("error", () => undefined);
    const portOf = (stream: "video" | "audio" | "mic"): number | undefined => ports[stream];
    let stopRequested = false;
    const run: FfmpegRun = {
        pid: child.pid,
        container: options.container,
        get stopping() {
            return stopRequested;
        },
        exited: exited.promise,
        send(stream, rtp) {
            const port = portOf(stream);
            if (port !== undefined && !gone) out.send(rtp, port, "127.0.0.1");
        },
        sendRtcp(stream, rtcp) {
            const port = portOf(stream);
            if (port !== undefined && !gone) out.send(rtcp, port + 1, "127.0.0.1");
        },
        async stop(secondSigintAfterMs = 4000, killAfterMs = 12_000) {
            stopRequested = true;
            if (!gone) {
                // The first SIGINT is honoured between packets (the caller keeps some flowing). A blocked read needs a second one,
                // which also aborts the trailer write: the last fragment of an fMP4 is then lost, the file stays valid.
                child.kill("SIGINT");
                const second = setTimeout(() => child.kill("SIGINT"), secondSigintAfterMs);
                const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
                const exit = await exited.promise;
                clearTimeout(second);
                clearTimeout(killer);
                return { clean: exit.signal !== "SIGKILL", exit };
            }
            const exit = await exited.promise;
            return { clean: exit.signal !== "SIGKILL", exit };
        },
    };
    // Close the sender when the process dies by itself.
    void exited.promise.then(() => {
        try {
            out.close();
        } catch {
            // Already closed by stop().
        }
    });

    // Packets sent before ffmpeg has bound its sockets would be lost; wait until the ports are taken.
    const deadline = Date.now() + 15_000;
    const wanted = Object.values(ports);
    for (;;) {
        if (gone) {
            const exit = await exited.promise;
            await rm(sdpPath, { force: true });
            throw new Error(`ffmpeg exited while starting: ${exit.tail.slice(-3).join(" | ")}`);
        }
        let bound = 0;
        for (const port of wanted) if (!(await tryBind(port))) bound += 1;
        if (bound === wanted.length) break;
        if (Date.now() > deadline) {
            child.kill("SIGKILL");
            await rm(sdpPath, { force: true });
            throw new Error("ffmpeg did not open its input ports in 15 s");
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    return run;
}
