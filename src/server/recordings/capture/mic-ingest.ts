import { randomBytes } from "node:crypto";
import { RtcpSenderInfo, RtcpSrPacket } from "werift";
import { ntpFromUnixMs } from "./rtp-rebase";

/**
 * The browser's microphone as the recording's second audio track.
 *
 * The browser sends Opus packets with the time each was captured. This turns them into an RTP stream for ffmpeg (payload type 112,
 * 48 kHz) with RTCP sender reports carrying NTP time, so ffmpeg lines the track up with the Pi's audio and video by wall clock.
 *
 *  - Time comes from `ptsMs`, not from arrival: HTTP uploads are bursty and late, the capture clock is not. A small `jitterMs`
 *    delay lets late and re-ordered frames take their place; a frame later than that is dropped.
 *  - A track that stopped for any reason (muted, tab closed, nothing sent yet) is filled with Opus digital silence so the track
 *    stays continuous. ffmpeg's muxer holds back a stream with no packets, so a silent track would otherwise stall the others.
 *  - Frames may be 2.5 to 60 ms and may pack several frames (RFC 6716 TOC byte); the duration is read from the packet.
 *  - Without `start()` nothing is sent. A recording without microphone simply never creates this object.
 */

export const MIC_PAYLOAD_TYPE = 112;
const CLOCK_RATE = 48_000;
const TICK_MS = 20;
/** One 20 ms frame of digital silence (CELT, fullband, mono): what an Opus encoder emits for silence. */
export const MIC_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE = MIC_SILENCE_FRAME;
const SILENCE_MS = 20;
/** A silent stretch longer than this is jumped over instead of filled (the RTP timestamp leaps; the track has a gap). */
const MAX_FILL_MS = 120_000;
/** A frame this close to where the last one ended is taken as contiguous with it. */
const SNAP_MS = 15;

export interface MicIngestOptions {
    sendRtp: (packet: Buffer) => void;
    sendRtcp: (packet: Buffer) => void;
    /** Added to every `ptsMs` to bring it to this host's `Date.now()` domain. */
    clockOffsetMs: number;
    jitterMs: number;
    now?: () => number;
}

interface Queued {
    startMs: number;
    durationMs: number;
    data: Buffer;
}

export interface MicStats {
    framesIn: number;
    framesOut: number;
    silenceFrames: number;
    droppedLate: number;
    droppedInvalid: number;
}

/** Duration in ms of the Opus packet, or null when it is not a valid packet. */
export function opusPacketDurationMs(data: Uint8Array): number | null {
    if (data.length < 1) return null;
    const toc = data[0]!;
    const config = toc >> 3;
    let frameMs: number;
    if (config < 12) frameMs = [10, 20, 40, 60][config & 3]!;
    else if (config < 16) frameMs = config & 1 ? 20 : 10;
    else frameMs = [2.5, 5, 10, 20][config & 3]!;
    const code = toc & 3;
    let frames: number;
    if (code === 0) frames = 1;
    else if (code === 1 || code === 2) frames = 2;
    else {
        if (data.length < 2) return null;
        frames = data[1]! & 0x3f;
        if (frames === 0) return null;
    }
    const total = frameMs * frames;
    return total > 120 ? null : total;
}

export class MicIngest {
    readonly stats: MicStats = { framesIn: 0, framesOut: 0, silenceFrames: 0, droppedLate: 0, droppedInvalid: 0 };
    readonly #options: MicIngestOptions;
    readonly #ssrc = randomBytes(4).readUInt32BE(0);
    readonly #baseTs = randomBytes(4).readUInt32BE(0);
    #seq = randomBytes(2).readUInt16BE(0);
    #queue: Queued[] = [];
    #originMs = 0;
    #nextMs = 0;
    #timer: NodeJS.Timeout | undefined;
    #lastSrAt = 0;
    #packets = 0;
    #octets = 0;
    #started = false;

    constructor(options: MicIngestOptions) {
        this.#options = options;
    }

    get running(): boolean {
        return this.#started;
    }

    #now(): number {
        return (this.#options.now ?? Date.now)();
    }

    /** Starts the track at the host time `originMs` (the instant the capture's timeline begins). */
    start(originMs: number): void {
        if (this.#started) return;
        this.#started = true;
        this.#originMs = originMs;
        this.#nextMs = originMs;
        this.#timer = setInterval(() => this.#tick(false), TICK_MS);
        this.#timer.unref();
    }

    push(ptsMs: number, data: Uint8Array): void {
        this.stats.framesIn += 1;
        const durationMs = opusPacketDurationMs(data);
        if (durationMs === null || !Number.isFinite(ptsMs)) {
            this.stats.droppedInvalid += 1;
            return;
        }
        const startMs = ptsMs + this.#options.clockOffsetMs;
        const frame: Queued = { startMs, durationMs, data: Buffer.from(data) };
        // Insertion into a short, nearly sorted queue.
        let i = this.#queue.length;
        while (i > 0 && this.#queue[i - 1]!.startMs > startMs) i -= 1;
        this.#queue.splice(i, 0, frame);
    }

    /** Sends everything still queued, in order, and ends the track's pacing. */
    stop(): void {
        if (!this.#started) return;
        clearInterval(this.#timer);
        this.#tick(true);
        this.#started = false;
    }

    #tick(flush: boolean): void {
        const now = this.#now();
        const horizon = flush ? Number.POSITIVE_INFINITY : now - this.#options.jitterMs;
        for (;;) {
            const head = this.#queue[0];
            if (head && head.startMs <= horizon) {
                this.#queue.shift();
                if (head.startMs + head.durationMs <= this.#nextMs + 1) {
                    this.stats.droppedLate += 1;
                    continue;
                }
                const gap = head.startMs - this.#nextMs;
                if (gap > SNAP_MS) {
                    if (gap <= MAX_FILL_MS) {
                        while (head.startMs - this.#nextMs > SNAP_MS) this.#emit(SILENCE, SILENCE_MS, true);
                    } else this.#nextMs = head.startMs;
                }
                this.#emit(head.data, head.durationMs, false);
                continue;
            }
            if (flush) break;
            // Nothing real is due: keep the track moving with silence up to the horizon, unless a frame starts inside the slot.
            if (horizon - this.#nextMs >= SILENCE_MS && (!head || head.startMs >= this.#nextMs + SILENCE_MS - SNAP_MS)) {
                this.#emit(SILENCE, SILENCE_MS, true);
                continue;
            }
            break;
        }
        if (now - this.#lastSrAt >= 1000 && this.#packets > 0) {
            this.#lastSrAt = now;
            const rtp = (this.#baseTs + Math.round(((now - this.#originMs) * CLOCK_RATE) / 1000)) >>> 0;
            this.#options.sendRtcp(
                new RtcpSrPacket({
                    ssrc: this.#ssrc,
                    senderInfo: new RtcpSenderInfo({ ntpTimestamp: ntpFromUnixMs(now), rtpTimestamp: rtp, packetCount: this.#packets, octetCount: this.#octets }),
                }).serialize(),
            );
        }
    }

    #emit(payload: Buffer, durationMs: number, silence: boolean): void {
        const header = Buffer.allocUnsafe(12);
        header[0] = 0x80;
        header[1] = MIC_PAYLOAD_TYPE;
        header.writeUInt16BE(this.#seq, 2);
        this.#seq = (this.#seq + 1) & 0xffff;
        header.writeUInt32BE((this.#baseTs + Math.round(((this.#nextMs - this.#originMs) * CLOCK_RATE) / 1000)) >>> 0, 4);
        header.writeUInt32BE(this.#ssrc, 8);
        this.#options.sendRtp(Buffer.concat([header, payload]));
        this.#nextMs += durationMs;
        this.#packets += 1;
        this.#octets += payload.length;
        this.stats.framesOut += 1;
        if (silence) this.stats.silenceFrames += 1;
    }
}
