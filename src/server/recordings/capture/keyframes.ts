/**
 * Keyframes for the master: detect IDRs in the RTP H.264 stream, ask for them, and keep exactly one per request.
 *
 * The Pi sends no keyframe unless asked (RTCP PLI). So the gate:
 *  - waits for the first IDR of every session and forwards nothing before it (a file that starts on a P frame cannot be decoded);
 *  - asks again every `retryMs` until it comes;
 *  - then asks every `intervalMs` (the master's seek granularity; the stored file gets its own, denser keyframes when re-encoded);
 *  - does not ask when another viewer's request already produced a keyframe: it counts as ours;
 *  - drops the duplicate IDR. Each PLI makes the Pi send two IDR access units about 40 ms apart. The gate holds a keyframe for
 *    `dupWindowMs`; a second IDR inside the window replaces the held unit (and the few P frames between them) so the file has one
 *    keyframe per request. Dropping the SECOND would be wrong: the P frames after it are predicted from it. The hole this leaves is
 *    about 40 ms; timestamps keep their gap and sequence numbers are renumbered by the rebaser, so ffmpeg sees no loss.
 *  - treats a packet loss as damage. The rebaser renumbers sequence numbers, so ffmpeg could never see a loss; the gate does. A keyframe
 *    with a gap inside it is thrown away and asked for again (every P frame after a damaged IDR would decode wrongly); a gap in P
 *    frames is forwarded and a fresh keyframe is requested to end the corruption.
 *
 * H.264 over RTP (RFC 6184): a packet is a single NAL (type 1..23), a STAP-A (24) of several, or a fragment of one (FU-A, 28).
 */

export interface GatePacket {
    header: { timestamp: number; sequenceNumber: number; marker: boolean };
    payload: Buffer;
}

export interface NalSummary {
    /** The packet carries (part of) an IDR slice (NAL type 5). */
    idr: boolean;
    /** The packet BEGINS an IDR slice (a single NAL, a STAP-A member, or the first FU-A fragment). */
    idrStart: boolean;
    /** The packet carries a whole SPS or PPS (types 7, 8). */
    params: boolean;
}

const NONE: NalSummary = { idr: false, idrStart: false, params: false };

function summary(idr: boolean, idrStart: boolean, params: boolean): NalSummary {
    return idr || params ? { idr, idrStart, params } : NONE;
}

/** What the packet's NAL units are, from the first bytes of the payload. */
export function summariseNals(payload: Buffer): NalSummary {
    if (payload.length < 1) return NONE;
    const type = payload[0]! & 0x1f;
    if (type >= 1 && type <= 23) return summary(type === 5, type === 5, type === 7 || type === 8);
    if (type === 24) {
        let idr = false;
        let params = false;
        let offset = 1;
        while (offset + 3 <= payload.length) {
            const size = payload.readUInt16BE(offset);
            const inner = payload[offset + 2]! & 0x1f;
            if (inner === 5) idr = true;
            else if (inner === 7 || inner === 8) params = true;
            offset += 2 + size;
        }
        return summary(idr, idr, params);
    }
    if (type === 28 && payload.length >= 2) {
        // Every fragment repeats the inner type in its FU header; a parameter set never needs fragmenting in practice.
        const idr = (payload[1]! & 0x1f) === 5;
        return summary(idr, idr && (payload[1]! & 0x80) !== 0, false);
    }
    return NONE;
}

/** Signed difference of two 32-bit RTP timestamps (a - b). */
export function tsDiff(a: number, b: number): number {
    return (a - b) | 0;
}

export interface GateOptions {
    /** Milliseconds between periodic requests once running. 0 asks only when a keyframe is lost. */
    intervalMs: number;
    /** While waiting for a keyframe, ask again after this long. */
    retryMs: number;
    /** An IDR this soon after the previous one (RTP clock) is the duplicate. */
    dupWindowMs: number;
    /** After a loss in P frames, ask for a keyframe no more often than this. */
    lossRetryMs?: number;
    /** Send the PLI. Fire and forget. */
    request: () => void;
}

export interface GateStats {
    keyframes: number;
    duplicatesDropped: number;
    requests: number;
    /** Keyframes that arrived without our having asked since the last one (another viewer's request). */
    unsolicited: number;
    /** RTP packets missing from the Pi's stream (sequence gaps). */
    lostPackets: number;
    /** Keyframes thrown away because a packet inside them was lost. */
    damagedKeyframes: number;
}

interface Held<P> {
    packet: P;
    at: number;
    params: boolean;
    gapBefore: boolean;
}

type Mode = "waiting" | "collecting" | "live";

export class KeyframeGate<P extends GatePacket> {
    readonly stats: GateStats = { keyframes: 0, duplicatesDropped: 0, requests: 0, unsolicited: 0, lostPackets: 0, damagedKeyframes: 0 };
    #mode: Mode = "waiting";
    #held: Held<P>[] = [];
    #idrTs: number | null = null;
    #idrAt = 0;
    #lastKeyAt = 0;
    #lastRequestAt = 0;
    #requestedSinceKey = false;
    /** A keyframe has been forwarded and the chain after it is unbroken as far as the gate knows. */
    #synced = false;
    #lastSeq: number | null = null;
    #lossPending = false;
    /** Consecutive damaged keyframes: each doubles the wait before asking again, so a receive buffer that is too small cannot cause a request storm. */
    #damageStreak = 0;
    readonly #options: GateOptions;
    readonly #emit: (packet: P, at: number) => void;
    readonly #onKeyframe: (at: number, requested: boolean) => void;

    constructor(options: GateOptions, emit: (packet: P, at: number) => void, onKeyframe: (at: number, requested: boolean) => void) {
        this.#options = options;
        this.#emit = emit;
        this.#onKeyframe = onKeyframe;
    }

    /** A new session (or a new ffmpeg): forward nothing until its first IDR. Anything held is discarded. */
    reset(): void {
        this.#mode = "waiting";
        this.#held = [];
        this.#idrTs = null;
        this.#synced = false;
        this.#lastSeq = null;
        this.#lossPending = false;
        this.#damageStreak = 0;
        this.#lastRequestAt = 0;
        this.#requestedSinceKey = false;
    }

    push(packet: P, at: number): void {
        const seq = packet.header.sequenceNumber;
        let gapBefore = false;
        if (this.#lastSeq !== null) {
            const gap = (seq - this.#lastSeq - 1) & 0xffff;
            // A "gap" of half the sequence space or more is a re-ordered or repeated packet, not a loss.
            if (gap > 0 && gap < 0x8000) {
                gapBefore = true;
                this.stats.lostPackets += gap;
                if (this.#mode === "live") this.#lossPending = true;
            }
        }
        this.#lastSeq = seq;
        const nals = summariseNals(packet.payload);
        const keyStart = nals.params || nals.idrStart;
        if (this.#mode === "live") {
            if (!keyStart) {
                this.#emit(packet, at);
                return;
            }
            this.#mode = "collecting";
            this.#held = [];
            this.#idrTs = null;
        } else if (this.#mode === "waiting") {
            if (!keyStart) {
                // A P frame cannot start the file. SEI and the like of a pending parameter-set unit share its timestamp: keep those.
                const last = this.#held[this.#held.length - 1];
                if (last && last.packet.header.timestamp !== packet.header.timestamp) this.#held = [];
                return;
            }
            this.#mode = "collecting";
            this.#held = [];
            this.#idrTs = null;
        }
        this.#collect({ packet, at, params: nals.params, gapBefore }, nals.idr);
    }

    #collect(entry: Held<P>, idr: boolean): void {
        const { packet, at } = entry;
        const ts = packet.header.timestamp;
        if (this.#idrTs === null) {
            const last = this.#held[this.#held.length - 1];
            if (!idr && !entry.params && last && last.packet.header.timestamp !== ts) {
                // The parameter sets were followed by a P frame, not an IDR: it was no keyframe unit.
                const held = this.#held;
                this.#held = [];
                if (this.#synced) {
                    this.#mode = "live";
                    for (const h of held) this.#emit(h.packet, h.at);
                    this.#emit(packet, at);
                } else this.#mode = "waiting";
                return;
            }
            this.#held.push(entry);
            if (idr) {
                this.#idrTs = ts;
                this.#idrAt = at;
            }
            return;
        }
        const windowTicks = this.#options.dupWindowMs * 90;
        const delta = tsDiff(ts, this.#idrTs);
        if (idr && delta > 0 && delta <= windowTicks) {
            // The duplicate IDR: the earlier unit goes, this one (with any parameter sets just before it) is kept.
            let start = this.#held.findIndex((h) => h.packet.header.timestamp === ts);
            if (start < 0) start = this.#held.length;
            while (start > 0 && this.#held[start - 1]!.params) start -= 1;
            this.#held = this.#held.slice(start);
            this.#held.push(entry);
            this.#idrTs = ts;
            this.#idrAt = at;
            this.stats.duplicatesDropped += 1;
            return;
        }
        if (delta > windowTicks || delta < 0) {
            this.#release();
            this.push(packet, at);
            return;
        }
        this.#held.push(entry);
    }

    #release(): void {
        const held = this.#held;
        this.#held = [];
        this.#idrTs = null;
        // Damaged: a packet is missing INSIDE the unit (a gap before its first packet is just the P frames dropped as the duplicate).
        const damaged = held.some((h, i) => i > 0 && h.gapBefore);
        // The very first keyframe of a file must carry its own parameter sets: ffmpeg builds the track header from them.
        const noParams = !this.#synced && !held.some((h) => h.params);
        if (damaged || noParams) {
            this.#mode = "waiting";
            this.#synced = false;
            if (damaged) {
                this.stats.damagedKeyframes += 1;
                this.#damageStreak += 1;
            }
            return;
        }
        this.#mode = "live";
        this.#synced = true;
        this.#lossPending = false;
        this.#damageStreak = 0;
        const firstIdrAt = this.#idrAt;
        for (const h of held) this.#emit(h.packet, h.at);
        this.stats.keyframes += 1;
        const requested = this.#requestedSinceKey;
        if (!requested) this.stats.unsolicited += 1;
        this.#requestedSinceKey = false;
        this.#lastKeyAt = firstIdrAt;
        this.#onKeyframe(this.#lastKeyAt, requested);
    }

    /** Call about every 50 ms with the clock: releases a held keyframe on a stalled stream and sends the requests. */
    tick(now: number): void {
        if (this.#mode === "collecting" && this.#idrTs !== null && now - this.#idrAt > this.#options.dupWindowMs + 150) this.#release();
        if (this.#mode === "waiting" || (this.#mode === "collecting" && !this.#synced)) {
            if (now - this.#lastRequestAt >= this.#options.retryMs * 2 ** Math.min(this.#damageStreak, 4)) this.#send(now);
        } else if (this.#mode === "live") {
            const sinceAsk = now - this.#lastRequestAt;
            if (this.#lossPending && sinceAsk >= (this.#options.lossRetryMs ?? 1000)) {
                this.#lossPending = false;
                this.#send(now);
            } else if (this.#options.intervalMs > 0) {
                // Another viewer's request that produced a keyframe restarts the interval: `#lastKeyAt` is the newest keyframe of any origin.
                if (now - this.#lastKeyAt >= this.#options.intervalMs && sinceAsk >= Math.min(this.#options.intervalMs, 2000)) this.#send(now);
            }
        }
    }

    #send(now: number): void {
        this.#lastRequestAt = now;
        this.#requestedSinceKey = true;
        this.stats.requests += 1;
        this.#options.request();
    }
}
