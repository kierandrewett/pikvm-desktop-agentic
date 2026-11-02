/**
 * The one time source the engine reads.
 *
 * Every timeout in the HID path (key hold, modifier settle, reconnect backoff, heartbeat,
 * queue staleness) goes through this port so a test can drive minutes of behaviour in
 * microseconds and, more importantly, in a deterministic order. Reading Date.now() or
 * calling setTimeout directly anywhere in the engine would make those tests either flaky
 * or blind, so nothing under src/target or src/input does.
 */

/** Cancels a pending timer. Safe to call after it has fired. */
export type CancelTimer = () => void;

export interface Clock {
    /** Milliseconds, monotonic enough for staleness and silence checks. */
    now(): number;
    /** Run `fn` once after `ms`. */
    setTimeout(fn: () => void, ms: number): CancelTimer;
}

/** The real clock. Date.now (not performance.now) so it keeps counting while a phone sleeps. */
export const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
    },
};
