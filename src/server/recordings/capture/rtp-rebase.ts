import { RtcpSenderInfo, RtcpSrPacket, RtpHeader, RtpPacket } from "werift";

/**
 * One outgoing RTP stream (what ffmpeg reads) fed by any number of Janus sessions in turn.
 *
 * A new session has a new SSRC and new random sequence and timestamp bases. ffmpeg must see ONE stream, so each packet is rewritten:
 *  - SSRC is a constant;
 *  - sequence numbers are a plain counter over the packets actually forwarded (so packets the keyframe gate dropped leave no gap
 *    that ffmpeg would take for loss);
 *  - the timestamp keeps the Pi's own spacing inside a session, and a new session is anchored to where the previous one stopped plus
 *    the wall-clock time between the two sessions' packets. The timeline therefore keeps the real hole instead of closing it.
 * Sender reports are rewritten with the same offsets so the (NTP, RTP) pair stays true; ffmpeg uses them to line video up with audio.
 */

export interface RebaserOptions {
    ssrc: number;
    clockRate: number;
    payloadType: number;
}

export class RtpRebaser {
    readonly ssrc: number;
    readonly clockRate: number;
    readonly payloadType: number;
    #session = -1;
    #seq = 0;
    #tsOffset = 0;
    #lastOutTs = 0;
    #lastAt = 0;
    #first = true;
    #count = 0;
    #octets = 0;
    #elapsedTicks = 0;

    constructor(options: RebaserOptions) {
        this.ssrc = options.ssrc >>> 0;
        this.clockRate = options.clockRate;
        this.payloadType = options.payloadType;
    }

    get packets(): number {
        return this.#count;
    }

    /** Milliseconds of timeline covered so far, from the first packet ever forwarded to the newest one. */
    get elapsedMs(): number {
        return (this.#elapsedTicks * 1000) / this.clockRate;
    }

    /** Whether a packet has been forwarded yet (SR rewriting needs the offsets). */
    get started(): boolean {
        return !this.#first;
    }

    /**
     * Rewrites `packet` in place and serialises it. `at` is the wall-clock arrival time in ms. The first packet of a session
     * re-anchors the timestamp; it is returned together with the size of the timeline step it caused.
     */
    rebase(packet: RtpPacket, session: number, at: number): { wire: Buffer; gapMs: number } {
        const header = packet.header;
        let gapMs = 0;
        if (this.#first) {
            this.#tsOffset = 0;
            this.#first = false;
            this.#seq = (header.sequenceNumber - 1) & 0xffff;
            this.#session = session;
            this.#lastOutTs = header.timestamp >>> 0;
        } else if (this.#session !== session) {
            const wallTicks = Math.max(0, Math.round(((at - this.#lastAt) / 1000) * this.clockRate));
            const target = (this.#lastOutTs + wallTicks) >>> 0;
            this.#tsOffset = (target - header.timestamp) >>> 0;
            this.#session = session;
            gapMs = Math.round(at - this.#lastAt);
        }
        const outTs = (header.timestamp + this.#tsOffset) >>> 0;
        const step = (outTs - this.#lastOutTs) | 0;
        if (step > 0) this.#elapsedTicks += step;
        if (step >= 0) this.#lastOutTs = outTs;
        this.#seq = (this.#seq + 1) & 0xffff;
        header.sequenceNumber = this.#seq;
        header.timestamp = outTs;
        header.ssrc = this.ssrc;
        header.payloadType = this.payloadType;
        this.#lastAt = at;
        this.#count += 1;
        this.#octets += packet.payload.length;
        return { wire: packet.serialize(), gapMs };
    }

    /**
     * A packet this module makes up (not the Pi's), continuing the stream at wall-clock time `at`. Used at stop: ffmpeg only notices
     * SIGINT between packets, so when the Pi is gone something must still arrive. Null before the first real packet.
     */
    filler(payload: Buffer, at: number, stepTicks: number): Buffer | null {
        if (this.#first) return null;
        const ticks = Math.max(1, stepTicks);
        const outTs = (this.#lastOutTs + ticks) >>> 0;
        this.#seq = (this.#seq + 1) & 0xffff;
        const header = new RtpHeader({ payloadType: this.payloadType, sequenceNumber: this.#seq, timestamp: outTs, ssrc: this.ssrc, marker: true });
        this.#elapsedTicks += ticks;
        this.#lastOutTs = outTs;
        this.#lastAt = at;
        this.#count += 1;
        this.#octets += payload.length;
        return new RtpPacket(header, payload).serialize();
    }

    /**
     * A sender report built from this host's clock: the newest forwarded packet's out timestamp paired with the wall time it arrived.
     * Used when the sender's own reports are inconsistent (see Capture.#trackSrDrift): the microphone's reports are host-clock too, so
     * the two audio tracks then share one clock and cannot drift apart however bad the sender's NTP mapping is.
     */
    hostClockReport(session: number): Buffer | null {
        if (this.#first || this.#session !== session) return null;
        return new RtcpSrPacket({
            ssrc: this.ssrc,
            senderInfo: new RtcpSenderInfo({ ntpTimestamp: ntpFromUnixMs(this.#lastAt), rtpTimestamp: this.#lastOutTs, packetCount: this.#count, octetCount: this.#octets }),
        }).serialize();
    }

    /** A sender report from the Pi, rewritten to this stream. Null before this session's first RTP packet has been forwarded. */
    rewriteSenderReport(session: number, ntpTimestamp: bigint, rtpTimestamp: number): Buffer | null {
        // Until this session's first packet has gone out, the offset belongs to the previous session.
        if (this.#first || this.#session !== session) return null;
        return new RtcpSrPacket({
            ssrc: this.ssrc,
            senderInfo: new RtcpSenderInfo({
                ntpTimestamp,
                rtpTimestamp: (rtpTimestamp + this.#tsOffset) >>> 0,
                packetCount: this.#count,
                octetCount: this.#octets,
            }),
        }).serialize();
    }
}

/** NTP timestamp (64-bit, seconds since 1900 in the high word) of a Unix time in milliseconds. */
export function ntpFromUnixMs(ms: number): bigint {
    const seconds = Math.floor(ms / 1000);
    const fraction = Math.floor(((ms - seconds * 1000) / 1000) * 2 ** 32);
    return (BigInt(seconds + 2208988800) << 32n) | BigInt(fraction >>> 0);
}
