/**
 * The person's microphone, sent to the host as Opus while it records.
 *
 * The host makes the recording and its second audio track is this one. The page captures the microphone, cuts it into 20 ms frames
 * in an AudioWorklet, encodes each with WebCodecs `AudioEncoder` ("opus", 48 kHz, mono, 24 kbit/s) and sends them over a WebSocket
 * (`/app/api/v1/recordings/<id>/mic`, the contract describes the framing): 8 bytes of the frame's capture time on this page's clock, then
 * the Opus packet. The host turns the times into its own clock from the hello this sends first.
 *
 * Why this and not MediaRecorder: its audio/webm;codecs=opus output is a WebM stream, which the host would have to take apart, and
 * Safari has no Opus MediaRecorder at all. `AudioEncoder` gives the packets themselves. Where it cannot encode Opus (Safari before 26,
 * Firefox before 130) `micSupport` says so, and the recording simply has no microphone track; nothing is encoded in JavaScript.
 *
 * Time. A frame's time is the page's wall clock when its first sample was captured, worked out from the audio clock (which does not
 * wobble) and the wall clock at arrival (which does): the lowest arrival delay seen in the last 10 to 20 s says where the audio clock
 * sits on the wall clock, and the offset follows it by at most a quarter of a millisecond a frame, so a long recording keeps in step
 * without a jump the host would hear.
 */

import { MAX_MIC_FRAME_BYTES, MIC_FRAME_HEADER_BYTES, type MicHello } from "@pikvm/contracts/recordings";
import { micSocketUrl } from "./api";

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;
/** One frame (20 ms) in microseconds. */
const FRAME_US = (FRAME_SAMPLES * 1_000_000) / SAMPLE_RATE;
const BITRATE = 24_000;
const WORKLET_NAME = "pikvm-mic-framer";
/** The anchor of audio time on wall time moves at most this much (ms) a frame. */
const MAX_SLEW_MS = 0.25;
/** The window the lowest arrival delay is taken over, in milliseconds of audio time; two of them are kept. */
const ANCHOR_WINDOW_MS = 10_000;
/** Frames wait in the encoder and the socket no longer than this; older ones are dropped, never queued (the host fills the gap with silence). */
const MAX_ENCODE_QUEUE = 25;
const MAX_SOCKET_BACKLOG_BYTES = 64 * 1024;
const RECONNECT_MS = [500, 1000, 2000, 4000, 8000] as const;

const WORKLET_SOURCE = `
class MicFramer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(${FRAME_SAMPLES});
        this.filled = 0;
        this.start = 0;
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;
        let at = 0;
        while (at < channel.length) {
            if (this.filled === 0) this.start = currentFrame + at;
            const take = Math.min(channel.length - at, this.buffer.length - this.filled);
            this.buffer.set(channel.subarray(at, at + take), this.filled);
            this.filled += take;
            at += take;
            if (this.filled === this.buffer.length) {
                this.port.postMessage({ pcm: this.buffer, start: this.start }, [this.buffer.buffer]);
                this.buffer = new Float32Array(${FRAME_SAMPLES});
                this.filled = 0;
            }
        }
        return true;
    }
}
registerProcessor("${WORKLET_NAME}", MicFramer);
`;

/** The encoder's settings. `opus` is the codec's own options, which not every browser reads; the rest is what decides support. */
const ENCODER_CONFIG: AudioEncoderConfig & { opus?: { application: string; frameDuration: number; useinbandfec: boolean } } = {
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: BITRATE,
    opus: { application: "voip", frameDuration: 20_000, useinbandfec: true },
};

let support: Promise<string | null> | undefined;

/** Why this browser cannot send its microphone to the host, in a sentence, or null when it can. Asked once. */
export function micSupport(): Promise<string | null> {
    support ??= (async (): Promise<string | null> => {
        if (!navigator.mediaDevices?.getUserMedia) return "This browser cannot reach a microphone here (it needs a secure page).";
        if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return "This browser cannot encode sound for the host (no WebCodecs audio), so the recording has no microphone track.";
        if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") return "This browser cannot process the microphone, so the recording has no microphone track.";
        try {
            const result = await AudioEncoder.isConfigSupported(ENCODER_CONFIG);
            return result.supported ? null : "This browser cannot encode Opus, so the recording has no microphone track.";
        } catch {
            return "This browser cannot encode Opus, so the recording has no microphone track.";
        }
    })();
    return support;
}

export function micFailureText(error: unknown): string {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "the browser did not allow the microphone";
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no microphone was found";
    return "the microphone could not be opened";
}

/** The microphone, from the pinned device ("" follows the system default). The device is asked for with `exact`, so a gone headset is named and never replaced. */
export function openMicStream(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
}

/** A context for the feed. Made inside the click that starts a recording: one made after an await may be refused sound. */
export function newMicContext(): AudioContext {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    void ctx.resume().catch(() => undefined);
    return ctx;
}

export type MicEnd =
    /** The host closed the recording. */
    | "ended"
    /** Another page took over the microphone. */
    | "replaced"
    /** The host refuses (no such recording, or it takes no microphone). */
    | "refused"
    /** The microphone or the encoder failed. */
    | "failed";

export interface MicFeed {
    /** Lets go of the microphone and closes the socket. Idempotent. */
    stop(): void;
}

export interface MicFeedOptions {
    readonly stream: MediaStream;
    readonly context: AudioContext;
    readonly recordingId: string;
    /** The feed ended by itself; it has already let go of everything. Not called after `stop`. */
    readonly onEnd: (why: MicEnd, detail: string) => void;
}

/** Starts sending. Rejects (after letting go of everything) when the browser cannot set the pipeline up. */
export async function startMicFeed(options: MicFeedOptions): Promise<MicFeed> {
    const { stream, context: ctx, recordingId } = options;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const nodes: AudioNode[] = [];
    let encoder: AudioEncoder | null = null;
    const release = (): void => {
        stopped = true;
        clearTimeout(reconnect);
        const open = socket;
        socket = null;
        open?.close(1000, "stopped");
        for (const node of nodes) {
            try {
                node.disconnect();
            } catch {
                // Already apart.
            }
        }
        try {
            if (encoder && encoder.state !== "closed") encoder.close();
        } catch {
            // Already closed.
        }
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => undefined);
    };
    const end = (why: MicEnd, detail: string): void => {
        if (stopped) return;
        console.warn(`[recorder] the microphone feed ended (${why}): ${detail}`);
        release();
        options.onEnd(why, detail);
    };

    try {
        if (ctx.sampleRate !== SAMPLE_RATE) throw new Error(`the browser runs its audio at ${ctx.sampleRate} Hz, not ${SAMPLE_RATE}`);
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
        try {
            await ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }

        // The encoder numbers its output by the samples it was given, one frame after another, whatever gaps the capture had: so the frames
        // are handed to it on a timeline of their own (frame n at n x 20 ms) and this finds each one's real time (the page's wall clock) by it.
        const times = new Map<number, number>();
        let encoded = 0;
        const send = (data: Uint8Array, ptsMs: number): void => {
            const open = socket;
            if (!open || open.readyState !== WebSocket.OPEN || open.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES || data.length > MAX_MIC_FRAME_BYTES) return;
            const message = new ArrayBuffer(MIC_FRAME_HEADER_BYTES + data.length);
            new DataView(message).setFloat64(0, ptsMs, false);
            new Uint8Array(message, MIC_FRAME_HEADER_BYTES).set(data);
            open.send(message);
        };
        encoder = new AudioEncoder({
            output: (chunk) => {
                const pts = times.get(chunk.timestamp);
                times.delete(chunk.timestamp);
                if (pts === undefined) return;
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                send(data, pts);
            },
            error: (error) => end("failed", `The microphone's encoder stopped: ${error.message}`),
        });
        encoder.configure(ENCODER_CONFIG);

        let anchor: number | null = null;
        let windowMin = Number.POSITIVE_INFINITY;
        let previousMin = Number.POSITIVE_INFINITY;
        let windowEnd = 0;
        const worklet = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
        worklet.port.onmessage = (event: MessageEvent<{ pcm: Float32Array<ArrayBuffer>; start: number }>) => {
            const { pcm, start } = event.data;
            if (stopped || !encoder || encoder.state !== "configured") return;
            const startMs = (start * 1000) / SAMPLE_RATE;
            const lateness = Date.now() - (startMs + (FRAME_SAMPLES * 1000) / SAMPLE_RATE);
            if (startMs >= windowEnd) {
                previousMin = windowMin;
                windowMin = Number.POSITIVE_INFINITY;
                windowEnd = startMs + ANCHOR_WINDOW_MS;
            }
            windowMin = Math.min(windowMin, lateness);
            const wanted = Math.min(windowMin, previousMin);
            anchor = anchor === null ? wanted : anchor + Math.max(-MAX_SLEW_MS, Math.min(MAX_SLEW_MS, wanted - anchor));
            if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;
            const timestamp = encoded * FRAME_US;
            encoded += 1;
            times.set(timestamp, anchor + startMs);
            // Frames that never come out of the encoder (it dropped them) must not pile up here.
            if (times.size > 4 * MAX_ENCODE_QUEUE) times.delete(times.keys().next().value ?? 0);
            const audio = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp, data: pcm });
            encoder.encode(audio);
            audio.close();
        };

        const source = ctx.createMediaStreamSource(stream);
        // The worklet is pulled only when something reaches the destination: a gain of zero sends nothing to the speakers.
        const silent = ctx.createGain();
        silent.gain.value = 0;
        source.connect(worklet);
        worklet.connect(silent);
        silent.connect(ctx.destination);
        nodes.push(source, worklet, silent);
        const track = stream.getAudioTracks()[0];
        track?.addEventListener("ended", () => end("failed", "The microphone was unplugged or its permission was withdrawn."));
    } catch (error) {
        release();
        throw error;
    }

    const open = (): void => {
        if (stopped) return;
        const ws = new WebSocket(micSocketUrl(recordingId));
        ws.binaryType = "arraybuffer";
        socket = ws;
        ws.onopen = () => {
            attempts = 0;
            const hello: MicHello = { hello: 1, now: Date.now() };
            ws.send(JSON.stringify(hello));
        };
        ws.onclose = (event) => {
            if (socket !== ws || stopped) return;
            socket = null;
            if (event.code === 1000 || event.code === 1001) return end("ended", event.reason);
            if (event.code === 4000) return end("replaced", event.reason);
            if (event.code === 4404 || event.code === 4409) return end("refused", event.reason);
            if (event.code === 1008 || event.code === 1002) return end("failed", event.reason);
            // The link dropped: try again, and the host fills the gap with silence meanwhile.
            reconnect = setTimeout(open, RECONNECT_MS[Math.min(attempts, RECONNECT_MS.length - 1)]);
            attempts += 1;
        };
    };
    open();

    return { stop: release };
}
