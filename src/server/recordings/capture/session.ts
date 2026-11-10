import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { MIC_SILENCE_FRAME as SILENCE_FRAME } from "./mic-ingest";
import { basename, join } from "node:path";
import { RtcpSrPacket, type RtpPacket } from "werift";
import { startFfmpegRun, type FfmpegRun, type RawContainer } from "./ffmpeg-supervisor";
import { startJanusWatcher, type JanusWatcher } from "./janus-client";
import { KeyframeGate } from "./keyframes";
import { MicIngest } from "./mic-ingest";
import { RtpRebaser } from "./rtp-rebase";
import {
    assembleStored,
    diskUsageOf,
    ensureDirs,
    probeVideo,
    rawPathOf,
    saveManifest,
    storedPathOf,
    type Manifest,
    type SegmentRecord,
} from "./segments";
import type { AudioRole } from "./transcode";
import { grantedReceiveBufferBytes, installUdpReceiveBuffer, MIN_SAFE_RECEIVE_BUFFER_BYTES } from "./udp-buffer";
import type {
    CaptureEndReason,
    CaptureEvent,
    CaptureHandle,
    CaptureHole,
    CaptureOptions,
    CaptureResult,
    CompactResult,
    DiskUsage,
    MicFrame,
} from "./types";

/**
 * Host-side session recording: the host joins the PiKVM's Janus stream itself and writes what the Pi sends, with no browser open.
 *
 * ## Public API (everything else in this directory is internal)
 *
 *   import { createReencoder } from "./capture/transcode";
 *   import { startCapture } from "./capture/session";
 *
 *   const reencoder = createReencoder({ shouldPause: () => transcriber.busy() });   // ONE per process, shared by all captures
 *   const capture = startCapture({
 *       target: await control.proxyTarget(),      // { origin, headers, rejectUnauthorized }: what DeskTarget already is
 *       outputPath: join(dir, `${id}.mp4`),       // the compact file the recording ends as
 *       workDir: join(dataDir, "recordings", `${id}.parts`),   // REQUIRED, on the data volume (NOT /tmp: tmpfs is RAM); same filesystem as outputPath
 *       mic: true,                                // second audio track fed by pushMic (omit for none)
 *       reencoder,
 *       limits: { maxBytes: () => Math.min(perRecordingCap, quotaLeftFor(id)) },   // read ~every 2 s
 *       onEvent: (e) => ...,                      // connected / reconnecting / keyframe / segment / stored / hole / limit / error
 *   });
 *   capture.pushMic({ ptsMs, data });             // one Opus packet per call, ptsMs = the sender's Date.now() at capture
 *   const result = await capture.stop();          // CaptureResult; or `await capture.ended` when a limit closed it first
 *   const compact = await capture.compacted;      // { ok, value: { path, bytes, durationMs } } once the stored file exists
 *
 * ## What happens, in order
 *  1. ffmpeg starts and opens loopback UDP ports; then a Janus session opens (werift, large SO_RCVBUF, keepalive every 10 s).
 *  2. PLI until the first IDR (retry 500 ms), forwarded only from that IDR on; then a PLI every `keyframeIntervalMs` (30 s).
 *  3. RTP is rebased (one SSRC, contiguous sequence numbers, timestamps that keep real holes) and sent to ffmpeg, which writes raw
 *     segments (fMP4, or Matroska with a mic) of about `segmentMs` (5 min), each cut on a keyframe.
 *  4. Each closed raw segment is queued on the shared `Reencoder` (nice 19, one at a time). When it finishes the raw segment is deleted.
 *  5. On `stop()` (or a limit) ffmpeg gets SIGINT while packets still flow, the last segment is queued, `ended` resolves with the result.
 *     When the last stored segment is done they are joined (no re-encode) into `outputPath` and `compacted` resolves.
 *
 * ## Limits and accounting
 *  - `diskUsage()` = raw backlog + stored segments of this recording; the service adds the final file's size afterwards. Count that
 *    against the 10 GiB quota, and refuse a new recording (507) when the total would pass it, exactly as before.
 *  - Closed cleanly (never stalled) with `reason` "quota" / "recording_cap" when `limits.maxBytes()` is reached, "backlog_cap" when
 *    the raw backlog passes `maxRawBacklogBytes` (default 2 GiB: the re-encoder fell behind), "duration", or "error".
 *
 * ## After a host restart
 *  `recoverCapture` (recover.ts) takes a leftover work directory and finishes it: queues the raw segments, joins the stored ones.
 *
 * ## Facts it relies on (spike) and what is not proven
 *  See the comments in janus-client.ts, keyframes.ts, rtp-rebase.ts and ffmpeg-supervisor.ts.
 */

export const DEFAULT_KEYFRAME_INTERVAL_MS = 30_000;
export const DEFAULT_SEGMENT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_RAW_BACKLOG_BYTES = 2 * 1024 ** 3;
export const DEFAULT_UDP_RECEIVE_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_GIVE_UP_MS = 15 * 60 * 1000;
/** A video gap longer than this is a hole in the recording. */
const HOLE_MS = 1500;
const LIMIT_POLL_MS = 2000;
/** How many times ffmpeg is started before a capture gives up on it. */
const FFMPEG_START_ATTEMPTS = 3;
/** Sender reports whose NTP and RTP clocks disagree by more than this between two reports are not trusted. */
const SR_BAD_MS = 100;
const GATE_TICK_MS = 50;
/** A segment shorter than this (only a keyframe: the stop came right after a cut) is dropped instead of re-encoded. */
const MIN_SEGMENT_MS = 500;
const MAX_FFMPEG_RESTARTS = 5;
const FFMPEG_RESTART_WINDOW_MS = 120_000;

/** The knobs the environment may set, parsed for the service (this module never reads `process.env` itself). */
export function captureTuningFromEnv(env: NodeJS.ProcessEnv): Pick<CaptureOptions, "keyframeIntervalMs" | "segmentMs" | "udpReceiveBufferBytes"> & { maxRawBacklogBytes: number } {
    const num = (name: string, fallback: number): number => {
        const value = Number((env[name] ?? "").trim());
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        keyframeIntervalMs: num("PIKVM_RECORDINGS_KEYFRAME_SECONDS", DEFAULT_KEYFRAME_INTERVAL_MS / 1000) * 1000,
        segmentMs: num("PIKVM_RECORDINGS_SEGMENT_SECONDS", DEFAULT_SEGMENT_MS / 1000) * 1000,
        udpReceiveBufferBytes: num("PIKVM_RECORDINGS_UDP_RCVBUF_BYTES", DEFAULT_UDP_RECEIVE_BUFFER_BYTES),
        maxRawBacklogBytes: num("PIKVM_RECORDINGS_MAX_RAW_BACKLOG_BYTES", DEFAULT_MAX_RAW_BACKLOG_BYTES),
    };
}

const VIDEO_PT = 96;
const AUDIO_PT = 111;

function indexOfSegmentName(name: string): number | null {
    const match = /^seg-(\d+)\./.exec(name);
    return match ? Number(match[1]) : null;
}

class Capture implements CaptureHandle {
    readonly #options: CaptureOptions;
    readonly #workDir: string;
    readonly #id: string;
    readonly #log: (line: string) => void;
    readonly #listeners = new Set<(event: CaptureEvent) => void>();
    readonly #container: RawContainer;
    readonly #keyframeMs: number;
    readonly #segmentMs: number;
    readonly #ffmpegPath: string;
    readonly #ffprobePath: string;
    readonly #audioRoles: AudioRole[];
    readonly #video: RtpRebaser;
    readonly #audio: RtpRebaser;
    readonly #gate: KeyframeGate<RtpPacket>;
    readonly #mic: MicIngest | null;
    readonly #manifest: Manifest;
    readonly #jobs = new Map<number, Promise<void>>();
    readonly #ended = Promise.withResolvers<CaptureResult>();
    readonly #compacted = Promise.withResolvers<{ ok: true; value: CompactResult } | { ok: false; error: string }>();
    #watcher: JanusWatcher | null = null;
    #ffmpeg: FfmpegRun | null = null;
    #runBaseMs: number | null = null;
    #runStart = 0;
    #restarts: number[] = [];
    #session = 0;
    #videoLive = false;
    #startedWall: number | null = null;
    #timers: NodeJS.Timeout[] = [];
    #endPromise: Promise<CaptureResult> | null = null;
    #endReason: CaptureEndReason = "stopped";
    #endError: string | undefined;
    #clean = true;
    #rawBytesTotal = 0;
    #restartPending = false;
    #limitBusy = false;
    #audioSentAt = 0;
    /** Per stream: the previous sender report, and the worst disagreement between how far its NTP and its RTP clock advanced. */
    readonly #srPrev: { video?: { session: number; ntpMs: number; rtp: number }; audio?: { session: number; ntpMs: number; rtp: number } } = {};
    readonly #srDrift = { video: 0, audio: 0 };
    readonly #srBad = { video: false, audio: false };

    constructor(options: CaptureOptions) {
        this.#options = options;
        this.#workDir = options.workDir;
        this.#id = basename(options.outputPath).replace(/\.[^.]+$/, "");
        this.#log = options.log ?? (() => undefined);
        this.#container = options.mic ? "matroska" : "mp4";
        this.#keyframeMs = Math.max(1000, options.keyframeIntervalMs ?? DEFAULT_KEYFRAME_INTERVAL_MS);
        const wholeIntervals = Math.max(1, Math.round((options.segmentMs ?? DEFAULT_SEGMENT_MS) / this.#keyframeMs));
        this.#segmentMs = wholeIntervals * this.#keyframeMs;
        this.#ffmpegPath = options.ffmpegPath ?? "ffmpeg";
        this.#ffprobePath = options.ffprobePath ?? "ffprobe";
        this.#audioRoles = [...(options.audio === false ? [] : (["target"] as AudioRole[])), ...(options.mic ? (["mic"] as AudioRole[]) : [])];
        this.#video = new RtpRebaser({ ssrc: randomBytes(4).readUInt32BE(0), clockRate: 90_000, payloadType: VIDEO_PT });
        this.#audio = new RtpRebaser({ ssrc: randomBytes(4).readUInt32BE(0), clockRate: 48_000, payloadType: AUDIO_PT });
        this.#gate = new KeyframeGate(
            {
                intervalMs: this.#keyframeMs,
                retryMs: 500,
                dupWindowMs: 150,
                request: () => {
                    void this.#watcher?.requestKeyframe().catch(() => undefined);
                },
            },
            (packet, at) => this.#forwardVideo(packet, at),
            (atWall, requested) => this.#onKeyframe(atWall, requested),
        );
        this.#mic = options.mic
            ? new MicIngest({
                  sendRtp: (packet) => this.#ffmpeg?.send("mic", packet),
                  sendRtcp: (packet) => this.#ffmpeg?.sendRtcp("mic", packet),
                  clockOffsetMs: options.micClockOffsetMs ?? 0,
                  jitterMs: options.micJitterMs ?? 1500,
              })
            : null;
        this.#manifest = {
            version: 1,
            startedAtWall: Date.now(),
            container: this.#container,
            audioTracks: this.#audioRoles.length,
            hasMicTrack: false,
            segments: [],
            holes: [],
            ended: false,
        };
        void this.#boot();
    }

    get ended(): Promise<CaptureResult> {
        return this.#ended.promise;
    }

    get compacted(): Promise<{ ok: true; value: CompactResult } | { ok: false; error: string }> {
        return this.#compacted.promise;
    }

    onEvent(listener: (event: CaptureEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    pushMic(frame: MicFrame): void {
        this.#mic?.push(frame.ptsMs, frame.data);
    }

    diskUsage(): Promise<DiskUsage> {
        return diskUsageOf(this.#workDir);
    }

    stop(): Promise<CaptureResult> {
        return this.#end("stopped");
    }

    #emit(event: CaptureEvent): void {
        this.#options.onEvent?.(event);
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch (error) {
                this.#log(`[recorder] an event listener threw: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async #boot(): Promise<void> {
        try {
            await ensureDirs(this.#workDir);
            installUdpReceiveBuffer(this.#options.udpReceiveBufferBytes ?? DEFAULT_UDP_RECEIVE_BUFFER_BYTES);
            await this.#startFfmpeg();
            this.#startWatcher();
            this.#timers.push(setInterval(() => this.#gate.tick(Date.now()), GATE_TICK_MS));
            this.#timers.push(setInterval(() => void this.#checkLimits(), LIMIT_POLL_MS));
        } catch (error) {
            void this.#end("error", error instanceof Error ? error.message : String(error));
        }
    }

    // ---- ffmpeg ----

    async #startFfmpeg(): Promise<void> {
        const startNumber = Math.max(0, ...this.#manifest.segments.map((s) => s.index)) + (this.#manifest.segments.length ? 1 : 0);
        this.#runBaseMs = null;
        this.#runStart = startNumber;
        // One failed start (ffmpeg refusing its SDP or a port taken by a neighbour in the instant between our check and its bind) must not
        // end a recording: try again, with new ports and a new SDP file each time.
        let run: FfmpegRun | undefined;
        for (let attempt = 1; !run; attempt += 1) {
            try {
                run = await startFfmpegRun({
                    ffmpegPath: this.#ffmpegPath,
                    rawDir: join(this.#workDir, "raw"),
                    startNumber,
                    audio: this.#options.audio !== false,
                    mic: Boolean(this.#options.mic),
                    container: this.#container,
                    // Cut half an interval early so the first keyframe at or after it is the scheduled one at the nominal boundary.
                    segmentSeconds: (this.#segmentMs - this.#keyframeMs / 2) / 1000,
                    log: this.#log,
                    onSegment: (segment) => void this.#onSegment(segment.name, segment.startS, segment.endS),
                });
            } catch (error) {
                this.#log(`[recorder] ffmpeg start ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
                if (attempt >= FFMPEG_START_ATTEMPTS) throw error;
                const wait = Promise.withResolvers<void>();
                setTimeout(wait.resolve, 200);
                await wait.promise;
            }
        }
        this.#ffmpeg = run;
        void run.exited.then((exit) => {
            if (this.#ffmpeg !== run) return;
            this.#ffmpeg = null;
            if (run.stopping || this.#endPromise) return;
            this.#log(`[recorder] ffmpeg exited by itself (${exit.code ?? exit.signal}): ${exit.tail.slice(-3).join(" | ")}`);
            void this.#restartFfmpeg(exit.code === null ? String(exit.signal) : `exit ${exit.code}`);
        });
    }

    async #restartFfmpeg(reason: string): Promise<void> {
        if (this.#restartPending) return;
        this.#restartPending = true;
        try {
            const now = Date.now();
            this.#restarts = this.#restarts.filter((t) => now - t < FFMPEG_RESTART_WINDOW_MS);
            this.#restarts.push(now);
            this.#videoLive = false;
            await this.#adoptUnlisted();
            if (this.#restarts.length > MAX_FFMPEG_RESTARTS) {
                void this.#end("error", `ffmpeg crashed ${this.#restarts.length} times in ${FFMPEG_RESTART_WINDOW_MS / 1000} s (${reason})`);
                return;
            }
            this.#emit({ type: "ffmpeg-restart", reason, attempt: this.#restarts.length });
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, 500 * 2 ** (this.#restarts.length - 1));
            await wait.promise;
            if (this.#endPromise) return;
            await this.#startFfmpeg();
            // Only now, with ffmpeg listening, does the gate start waiting for the keyframe the new file must begin with.
            this.#videoLive = false;
            this.#gate.reset();
        } catch (error) {
            void this.#end("error", `could not restart ffmpeg: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.#restartPending = false;
        }
    }

    /** Raw files a dead or stopping ffmpeg left that its segment list never reported (the segment being written). */
    async #adoptUnlisted(): Promise<void> {
        const dir = join(this.#workDir, "raw");
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return;
        }
        const known = new Set(this.#manifest.segments.map((s) => s.index));
        for (const name of names.sort()) {
            const index = indexOfSegmentName(name);
            if (index === null || index < this.#runStart || known.has(index)) continue;
            const path = join(dir, name);
            const size = (await stat(path)).size;
            if (size === 0) {
                await rm(path, { force: true });
                continue;
            }
            const previous = this.#manifest.segments[this.#manifest.segments.length - 1];
            const startMs = previous ? previous.endMs : (this.#runBaseMs ?? 0);
            const media = await probeVideo(this.#ffprobePath, path);
            if (media.packets === 0) {
                // ffmpeg was killed right after opening this segment: nothing in it.
                await rm(path, { force: true });
                continue;
            }
            this.#addSegment({ index, name, startMs, endMs: startMs + media.durationMs, rawBytes: size, storedBytes: 0, state: "raw" });
        }
    }

    async #onSegment(name: string, startS: number, endS: number): Promise<void> {
        const index = indexOfSegmentName(name);
        if (index === null) return;
        const base = this.#runBaseMs ?? 0;
        let size = 0;
        try {
            size = (await stat(join(this.#workDir, "raw", name))).size;
        } catch {
            return;
        }
        this.#addSegment({ index, name, startMs: Math.round(base + startS * 1000), endMs: Math.round(base + endS * 1000), rawBytes: size, storedBytes: 0, state: "raw" });
    }

    #addSegment(record: SegmentRecord): void {
        if (this.#manifest.segments.some((s) => s.index === record.index)) return;
        if (record.endMs - record.startMs < MIN_SEGMENT_MS) {
            // A segment cut right before the end holds one keyframe and no audio: the re-encoder cannot make a file of it.
            this.#log(`[recorder] segment ${record.index} spans ${record.endMs - record.startMs} ms and is dropped`);
            void rm(rawPathOf(this.#workDir, record), { force: true });
            return;
        }
        this.#manifest.segments.push(record);
        this.#manifest.segments.sort((a, b) => a.index - b.index);
        this.#rawBytesTotal += record.rawBytes;
        this.#emit({ type: "segment", index: record.index, startMs: record.startMs, endMs: record.endMs, rawBytes: record.rawBytes });
        this.#queueReencode(record);
        void saveManifest(this.#workDir, this.#manifest).catch(() => undefined);
    }

    #queueReencode(record: SegmentRecord): void {
        record.state = "queued";
        const handle = this.#options.reencoder.submit({
            id: `${this.#id}:${record.index}`,
            input: rawPathOf(this.#workDir, record),
            output: storedPathOf(this.#workDir, record),
            audioRoles: this.#audioRoles,
        });
        const job = handle.done
            .then(async (result) => {
                record.state = "stored";
                record.storedBytes = result.bytes;
                await rm(rawPathOf(this.#workDir, record), { force: true });
                await saveManifest(this.#workDir, this.#manifest).catch(() => undefined);
                this.#emit({ type: "stored", index: record.index, storedBytes: result.bytes });
            })
            .catch((error: unknown) => {
                record.state = "failed";
                record.error = error instanceof Error ? error.message : String(error);
                this.#emit({ type: "error", message: `segment ${record.index} could not be re-encoded: ${record.error}`, fatal: false });
            });
        this.#jobs.set(record.index, job);
    }

    // ---- RTP path ----

    #startWatcher(): void {
        this.#watcher = startJanusWatcher({
            target: this.#options.target,
            video: true,
            audio: this.#options.audio !== false,
            log: this.#log,
            giveUpAfterMs: this.#options.giveUpAfterMs ?? DEFAULT_GIVE_UP_MS,
            sinks: {
                onSessionStart: (session) => {
                    this.#session = session;
                    this.#videoLive = false;
                    this.#gate.reset();
                    const granted = grantedReceiveBufferBytes();
                    if (granted !== null && granted < MIN_SAFE_RECEIVE_BUFFER_BYTES) {
                        this.#emit({ type: "warning", message: `UDP receive buffer is only ${granted} bytes (net.core.rmem_max is too low): keyframes may lose packets` });
                    }
                    this.#emit({ type: "connected", session, udpReceiveBufferBytes: granted });
                },
                onSessionEnd: (session, reason, retryInMs) => {
                    if (session === this.#session) this.#videoLive = false;
                    if (this.#endPromise) return;
                    if (retryInMs !== null) this.#emit({ type: "reconnecting", session, reason, retryInMs });
                },
                onVideoRtp: (packet, at, session) => {
                    if (session === this.#session) this.#gate.push(packet, at);
                },
                onAudioRtp: (packet, at, session) => {
                    if (!this.#videoLive || session !== this.#session || !this.#ffmpeg) return;
                    this.#audioSentAt = Date.now();
                    this.#ffmpeg.send("audio", this.#audio.rebase(packet, session, at).wire);
                },
                onRtcp: (kind, packet, _at, session) => {
                    if (!this.#videoLive || session !== this.#session || !this.#ffmpeg || !(packet instanceof RtcpSrPacket)) return;
                    this.#trackSrDrift(kind, session, packet.senderInfo.ntpTimestamp, packet.senderInfo.rtpTimestamp);
                    const rebaser = kind === "video" ? this.#video : this.#audio;
                    const wire = this.#srBad[kind]
                        ? rebaser.hostClockReport(session)
                        : rebaser.rewriteSenderReport(session, packet.senderInfo.ntpTimestamp, packet.senderInfo.rtpTimestamp);
                    if (wire) this.#ffmpeg.sendRtcp(kind, wire);
                },
            },
        });
        void this.#watcher.gaveUp.then((why) => this.#end("error", why));
    }

    #forwardVideo(packet: RtpPacket, at: number): void {
        const run = this.#ffmpeg;
        if (!run) return;
        const before = this.#video.elapsedMs;
        const { wire } = this.#video.rebase(packet, this.#session, at);
        const after = this.#video.elapsedMs;
        if (this.#runBaseMs === null) this.#runBaseMs = after;
        if (before > 0 && after - before > HOLE_MS) {
            const hole: CaptureHole = { fromMs: Math.round(before), toMs: Math.round(after) };
            this.#manifest.holes.push(hole);
            this.#emit({ type: "hole", ...hole });
        }
        run.send("video", wire);
    }

    #onKeyframe(at: number, requested: boolean): void {
        this.#videoLive = true;
        if (this.#startedWall === null) {
            this.#startedWall = at;
            this.#manifest.startedAtWall = at;
            this.#emit({ type: "started", atWall: at });
            if (this.#mic) {
                this.#mic.start(at);
                this.#manifest.hasMicTrack = true;
            }
        }
        this.#emit({ type: "keyframe", atMs: Math.round(this.#video.elapsedMs), requested });
    }

    // ---- limits ----

    async #checkLimits(): Promise<void> {
        if (this.#limitBusy || this.#endPromise) return;
        this.#limitBusy = true;
        try {
            const usage = await diskUsageOf(this.#workDir);
            const elapsedMs = Math.round(this.#video.elapsedMs);
            this.#emit({ type: "bytes", rawBytes: usage.rawBytes, storedBytes: usage.storedBytes, backlogBytes: usage.rawBytes, elapsedMs });
            const g = this.#gate.stats;
            const m = this.#mic?.stats;
            this.#emit({
                type: "stats",
                keyframes: g.keyframes,
                duplicatesDropped: g.duplicatesDropped,
                keyframeRequests: g.requests,
                unsolicitedKeyframes: g.unsolicited,
                lostPackets: g.lostPackets,
                damagedKeyframes: g.damagedKeyframes,
                micFramesOut: m?.framesOut ?? 0,
                micSilenceFrames: m?.silenceFrames ?? 0,
                micDroppedLate: m?.droppedLate ?? 0,
                srDriftVideoMs: Math.round(this.#srDrift.video),
                srDriftAudioMs: Math.round(this.#srDrift.audio),
                hostClockReports: this.#srBad.video || this.#srBad.audio,
            });
            const limits = this.#options.limits;
            const backlogCap = limits?.maxRawBacklogBytes ?? DEFAULT_MAX_RAW_BACKLOG_BYTES;
            if (usage.rawBytes >= backlogCap) {
                this.#emit({ type: "limit", reason: "backlog_cap", detail: `the raw backlog is ${usage.rawBytes} bytes (cap ${backlogCap}): the re-encoder is behind` });
                void this.#end("backlog_cap");
                return;
            }
            const allowed = limits?.maxBytes?.();
            if (allowed !== undefined && usage.totalBytes >= allowed) {
                const reason = limits?.maxBytesReason ?? "quota";
                this.#emit({ type: "limit", reason, detail: `${usage.totalBytes} bytes on disk reached the limit of ${allowed}` });
                void this.#end(reason);
                return;
            }
            if (limits?.maxDurationMs !== undefined && elapsedMs >= limits.maxDurationMs) {
                this.#emit({ type: "limit", reason: "duration", detail: `${elapsedMs} ms reached the limit of ${limits.maxDurationMs}` });
                void this.#end("duration");
            }
        } finally {
            this.#limitBusy = false;
        }
    }

    /**
     * Time no segment covers that no reconnect explains: what a killed ffmpeg never flushed (its last fragments) or a segment that
     * could not be adopted. The file has a gap there, so the result says so.
     */
    #addLostHoles(): void {
        const segments = this.#manifest.segments;
        for (let i = 1; i < segments.length; i += 1) {
            const fromMs = segments[i - 1]!.endMs;
            const toMs = segments[i]!.startMs;
            if (toMs - fromMs <= HOLE_MS || this.#manifest.holes.some((h) => h.fromMs < toMs && h.toMs > fromMs)) continue;
            this.#manifest.holes.push({ fromMs, toMs });
            this.#emit({ type: "hole", fromMs, toMs });
        }
        this.#manifest.holes.sort((a, b) => a.fromMs - b.fromMs);
    }

    // ---- end and compaction ----

    #end(reason: CaptureEndReason, error?: string): Promise<CaptureResult> {
        if (!this.#endPromise) {
            this.#endReason = reason;
            this.#endError = error;
            this.#endPromise = this.#finish();
        }
        return this.#endPromise;
    }

    /**
     * Between two sender reports of one session the NTP time and the RTP clock must advance by the same amount. A sender whose reports
     * disagree (the fake Pi's werift peer did, by hundreds of ms) gives ffmpeg a jittery timeline for that stream; the worst case seen
     * is reported in the `stats` event so a bad sender is visible instead of looking like a sync bug.
     */
    #trackSrDrift(kind: "video" | "audio", session: number, ntp: bigint, rtp: number): void {
        const ntpMs = Number(ntp >> 32n) * 1000 + (Number(ntp & 0xffffffffn) / 2 ** 32) * 1000;
        const previous = this.#srPrev[kind];
        if (previous && previous.session === session) {
            const rate = kind === "video" ? 90 : 48;
            const rtpMs = ((rtp - previous.rtp) >>> 0) / rate;
            const drift = Math.abs(ntpMs - previous.ntpMs - rtpMs);
            this.#srDrift[kind] = Math.max(this.#srDrift[kind], drift);
            // The Pi's own clocks agree to ppm (spike); a sender off by this much is broken, and ffmpeg would follow it.
            if (drift > SR_BAD_MS) this.#srBad[kind] = true;
        }
        this.#srPrev[kind] = { session, ntpMs, rtp };
    }

    /** Opus digital silence into the target-audio stream when nothing from the Pi has gone out for 100 ms (stop only). */
    #fillAudio(): void {
        const now = Date.now();
        if (now - this.#audioSentAt < 100 || !this.#ffmpeg || this.#options.audio === false) return;
        const wire = this.#audio.filler(SILENCE_FRAME, now, 960);
        if (!wire) return;
        this.#audioSentAt = now;
        this.#ffmpeg.send("audio", wire);
    }

    async #finish(): Promise<CaptureResult> {
        for (const timer of this.#timers) clearInterval(timer);
        this.#timers = [];
        if (this.#endError) this.#emit({ type: "error", message: this.#endError, fatal: true });
        // A boot still in progress may not have an ffmpeg yet.
        for (let i = 0; i < 100 && !this.#ffmpeg && this.#restartPending; i += 1) {
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, 50);
            await wait.promise;
        }
        const run = this.#ffmpeg;
        if (run) {
            // SIGINT is honoured only between packets. With the Pi gone nothing arrives, so the target-audio stream is kept moving with
            // Opus digital silence (the microphone track does the same by itself) until ffmpeg has closed its files.
            const filler = setInterval(() => this.#fillAudio(), 20);
            const stopped = await run.stop();
            clearInterval(filler);
            this.#clean = stopped.clean;
            if (!stopped.clean) this.#log(`[recorder] ffmpeg had to be killed: ${stopped.exit.tail.slice(-3).join(" | ")}`);
        }
        this.#mic?.stop();
        this.#ffmpeg = null;
        await this.#watcher?.close();
        await this.#adoptUnlisted();
        this.#addLostHoles();
        this.#manifest.ended = true;
        await saveManifest(this.#workDir, this.#manifest).catch(() => undefined);
        const result: CaptureResult = {
            path: this.#options.outputPath,
            durationMs: Math.round(this.#video.elapsedMs),
            bytes: this.#rawBytesTotal,
            hasMicTrack: this.#manifest.hasMicTrack,
            holes: this.#manifest.holes.map((h) => ({ ...h })),
            reason: this.#endReason,
            ...(this.#endError !== undefined ? { error: this.#endError } : {}),
            workDir: this.#workDir,
            clean: this.#clean,
        };
        this.#ended.resolve(result);
        void this.#compact().then((outcome) => this.#compacted.resolve(outcome));
        return result;
    }

    async #compact(): Promise<{ ok: true; value: CompactResult } | { ok: false; error: string }> {
        try {
            await Promise.all([...this.#jobs.values()]);
            const segments = this.#manifest.segments;
            const failed = segments.filter((s) => s.state === "failed");
            const rawLeft = segments.reduce((sum, s) => sum + (s.state === "stored" ? 0 : s.rawBytes), 0);
            if (!segments.some((s) => s.state === "stored")) {
                await rm(this.#workDir, { recursive: true, force: true });
                return { ok: false, error: failed.length ? `no segment could be re-encoded (${failed[0]?.error ?? "unknown"})` : "nothing was recorded" };
            }
            const joined = await assembleStored({
                ffmpeg: this.#ffmpegPath,
                ffprobe: this.#ffprobePath,
                workDir: this.#workDir,
                outputPath: this.#options.outputPath,
                segments,
            });
            const freed = this.#rawBytesTotal - rawLeft;
            if (failed.length === 0) await rm(this.#workDir, { recursive: true, force: true });
            else this.#emit({ type: "warning", message: `${failed.length} segment(s) could not be re-encoded and are kept raw in ${this.#workDir}` });
            return { ok: true, value: { path: this.#options.outputPath, bytes: joined.bytes, durationMs: joined.durationMs, rawBytesFreed: freed } };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}

/** Starts a capture. Returns at once; the connection happens in the background and is reported through events. */
export function startCapture(options: CaptureOptions): CaptureHandle {
    return new Capture(options);
}
