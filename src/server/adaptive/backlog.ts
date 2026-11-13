/**
 * What is queued toward one client, and how fast the client takes it (FAILURE_MODES.md A1, A5, A6).
 *
 * Node only knows what it has not yet handed to the kernel (`writableLength`). On a slow link almost everything waits in
 * the kernel's send buffer, which grows with the connection, so the kernel's own count (`tx_queue` in /proc/net/tcp:
 * sent but not acknowledged, plus not sent) is added where Linux allows it. A byte that is in `tx_queue` or in
 * `writableLength` has not reached the client yet.
 */

import { readFile } from "node:fs/promises";

/** `tx_queue` of every TCP socket, by `<local port>:<remote port>`, or null where /proc/net/tcp cannot be read. */
export async function readTcpQueues(files: readonly string[] = ["/proc/net/tcp", "/proc/net/tcp6"]): Promise<Map<string, number> | null> {
    const queues = new Map<string, number>();
    let any = false;
    for (const file of files) {
        let text: string;
        try {
            text = await readFile(file, "latin1");
        } catch {
            continue;
        }
        any = true;
        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);
            // sl local_address rem_address st tx_queue:rx_queue ...
            const local = fields[1];
            const remote = fields[2];
            const queue = fields[4];
            if (!local || !remote || !queue) continue;
            const tx = Number.parseInt(queue.slice(0, queue.indexOf(":")), 16);
            const lport = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
            const rport = Number.parseInt(remote.slice(remote.lastIndexOf(":") + 1), 16);
            if (Number.isFinite(tx) && Number.isFinite(lport) && Number.isFinite(rport)) queues.set(`${lport}:${rport}`, tx);
        }
    }
    return any ? queues : null;
}

export interface MeterOptions {
    queueFloorBytes: number;
    queueSeconds: number;
    deadLinkMs: number;
    /** Both ends of a tick must hold at least this much for the interval to count as the link running full. */
    saturatedBytes?: number;
}

/**
 * One client's link. `sent` is every byte handed to `res.write`; with what is still queued, the difference is what the
 * client's side has taken. The rate over a tick in which the queue never ran dry is the link's rate; otherwise it is
 * only a floor (the link was not asked for more).
 */
export class LinkMeter {
    /** Every byte handed to the socket. */
    sent = 0;
    /** Kernel `tx_queue` at the last tick; 0 and `kernel` false where it cannot be read. */
    kernelQueue = 0;
    kernel = false;
    /** Bytes a second the link has been seen to carry; 0 until it carried anything. */
    capacityBps = 0;
    /** Bytes a second the client has been taking lately (smoothed); what it is sent when it is not saturated. */
    deliveredBps = 0;
    private writable = 0;
    private lastDelivered = 0;
    private lastQueued = 0;
    private lastTickAt: number;
    private lastProgressAt: number;

    constructor(
        private readonly options: MeterOptions,
        now: number,
    ) {
        this.lastTickAt = now;
        this.lastProgressAt = now;
    }

    /** Bytes that have not reached the client, as of the last tick plus what Node holds right now. */
    queued(writableLength: number): number {
        return writableLength + this.kernelQueue;
    }

    /** The most that may be queued before a due frame is dropped: seconds of data at the link's rate, never under the floor. */
    limit(): number {
        return Math.max(this.options.queueFloorBytes, this.capacityBps * this.options.queueSeconds);
    }

    /** True when data has sat queued without any of it being taken for `deadLinkMs`. */
    dead(now: number, writableLength: number): boolean {
        return this.queued(writableLength) > 0 && now - this.lastProgressAt > this.options.deadLinkMs;
    }

    /** Called every tick with the socket's `writableLength` and, where known, the kernel's `tx_queue` for it. */
    tick(now: number, writableLength: number, kernelQueue: number | null): void {
        this.kernel = kernelQueue !== null;
        this.kernelQueue = kernelQueue ?? 0;
        this.writable = writableLength;
        const queued = writableLength + this.kernelQueue;
        const delivered = this.sent - queued;
        const dt = now - this.lastTickAt;
        if (dt < 100) return;
        const rate = Math.max(0, ((delivered - this.lastDelivered) * 1000) / dt);
        this.deliveredBps = this.deliveredBps === 0 ? rate : this.deliveredBps * 0.7 + rate * 0.3;
        const full = this.options.saturatedBytes ?? 8192;
        if (this.lastQueued >= full && queued >= full) {
            // The queue never ran dry in this interval: the link took exactly what it can.
            this.capacityBps = this.capacityBps === 0 ? rate : this.capacityBps * 0.5 + rate * 0.5;
        } else if (rate > this.capacityBps) {
            this.capacityBps = rate;
        }
        if (delivered > this.lastDelivered || queued === 0) this.lastProgressAt = now;
        this.lastDelivered = delivered;
        this.lastQueued = queued;
        this.lastTickAt = now;
    }

    /** `writableLength` as of the last tick, for the status. */
    get writableAtTick(): number {
        return this.writable;
    }
}
