import { isRelease, type HidCommand } from "./wire";

/**
 * Input queued while the socket is down.
 *
 * The queue exists so a momentary blip does not swallow a keystroke: the reconnect is on a
 * 1.2 s timer, so the gap it is built for is about a second. It must have an age limit,
 * though. Without one a 1.2 s blip and a Pi reboot are treated the same, and typing a, b, c
 * into a dead socket delivers all six events twenty seconds later into whatever the target
 * is showing by then (a boot menu, a login prompt, a shell). A keystroke is only worth
 * delivering while it is still current.
 *
 * Releases are the exception to both limits. If the down went out before the socket died and
 * the up is dropped, the target holds that key or button forever.
 */
export const QUEUE_STALE_MS = 2000;
export const QUEUE_MAX = 256;

interface Item {
    readonly at: number;
    readonly command: HidCommand;
}

export interface OutboundQueue {
    push(command: HidCommand, now: number): void;
    /** Everything still worth sending, in order; empties the queue. */
    drain(now: number): HidCommand[];
    size(): number;
}

export function createOutboundQueue(staleMs = QUEUE_STALE_MS, max = QUEUE_MAX): OutboundQueue {
    let items: Item[] = [];
    return {
        push(command, now) {
            if (items.length >= max) {
                // Full. A new press or move is the one to lose. A release must still get
                // through, so it takes the place of the oldest non-release (an unsent press
                // whose own release is harmless without it); only a queue of nothing but
                // releases grows past the cap.
                if (!isRelease(command)) return;
                const victim = items.findIndex((i) => !isRelease(i.command));
                if (victim >= 0) items.splice(victim, 1);
            }
            items.push({ at: now, command });
        },
        drain(now) {
            const out = items.filter((i) => isRelease(i.command) || now - i.at < staleMs).map((i) => i.command);
            items = [];
            return out;
        },
        size: () => items.length,
    };
}
