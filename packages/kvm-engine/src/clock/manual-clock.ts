import type { CancelTimer, Clock } from "./clock";

/**
 * A clock that only moves when told to, for tests (and for anything that needs to replay a
 * timeline). Timers fire in due-time order, ties in scheduling order, and a timer scheduled
 * by a callback inside the advanced window fires in the same advance if it falls due in it.
 */
export interface ManualClock extends Clock {
    /** Move time forward, firing every timer that falls due, synchronously. */
    advance(ms: number): void;
    /**
     * Like `advance`, but yields to the microtask queue after each timer. Needed when the
     * code under test resumes through promises or Effect fibers: each wake-up must be able to
     * schedule its follow-up timer before the next one fires, or the timeline collapses.
     */
    advanceAsync(ms: number): Promise<void>;
    /** Let queued microtasks (promise callbacks, Effect fibers) run without moving time. */
    settle(): Promise<void>;
    /** Timers not yet fired or cancelled. */
    pending(): number;
}

interface Timer {
    readonly id: number;
    readonly due: number;
    readonly fn: () => void;
}

export function createManualClock(start = 0): ManualClock {
    let current = start;
    let nextId = 1;
    let timers: Timer[] = [];

    const takeNext = (limit: number): Timer | undefined => {
        let best: Timer | undefined;
        for (const t of timers) {
            if (t.due > limit) continue;
            if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
        }
        if (best) timers = timers.filter((t) => t !== best);
        return best;
    };

    const settle = async (): Promise<void> => {
        // Effect resumes through several chained microtasks; a fixed generous count keeps the
        // helper dependency-free and is cheap when nothing is waiting.
        for (let i = 0; i < 40; i++) await Promise.resolve();
    };

    return {
        now: () => current,
        setTimeout(fn, ms): CancelTimer {
            const timer: Timer = { id: nextId++, due: current + Math.max(0, ms), fn };
            timers.push(timer);
            return () => {
                timers = timers.filter((t) => t !== timer);
            };
        },
        advance(ms) {
            const limit = current + ms;
            for (let t = takeNext(limit); t; t = takeNext(limit)) {
                current = Math.max(current, t.due);
                t.fn();
            }
            current = limit;
        },
        async advanceAsync(ms) {
            const limit = current + ms;
            await settle();
            for (let t = takeNext(limit); t; t = takeNext(limit)) {
                current = Math.max(current, t.due);
                t.fn();
                await settle();
            }
            current = limit;
            await settle();
        },
        settle,
        pending: () => timers.length,
    };
}
