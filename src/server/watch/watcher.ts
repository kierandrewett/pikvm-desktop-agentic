import type { Frame, Grid } from "./frame-diff";
import { NO_SIGNAL_LOOKS } from "./limits";
import type { Alerts } from "./alerts";

/**
 * The one poller for the PiKVM, shared by every user whose watch is on.
 *
 * It takes a snapshot every `intervalMs` (1 s; and only while somebody's watch is attached: the last one to leave stops it), reduces it
 * to a grey grid once, and hands the same frame to each user's pipeline. When a pipeline has a corner change pending it also gets one
 * extra look at the moment that change will have held long enough, so a pop-up is notified at the settle time and not at the next look
 * after it. A look that finds no signal or no PiKVM hands no frame on (so the screen going black is not mistaken for a pop-up) but keeps
 * the state of the signal: two looks in a row with no signal count as "no signal".
 */

export type Snapshot =
    | { kind: "frame"; jpeg: Buffer }
    /** The PiKVM answered and says there is no video signal. */
    | { kind: "no-signal" }
    /** The PiKVM did not answer. */
    | { kind: "unreachable"; message: string };

export interface WatcherDeps {
    snapshot(signal: AbortSignal): Promise<Snapshot>;
    /** The frame as a grey grid; null when it cannot be read. */
    grid(jpeg: Buffer): Promise<Grid | null>;
    intervalMs: number;
    now(): number;
    /** Run `fn` after `ms`; returns a function that cancels it. Tests pass a manual one. */
    schedule?(fn: () => void, ms: number): () => void;
    log?(line: string): void;
}

/** What the poller needs of a pipeline: a pop-up watch (alerts.ts) or an agent's screen wait (screen-wait.ts). */
export type Pipeline = Pick<Alerts, "look" | "wakeAt">;

/** The least wait before an extra look for a pending corner change: a change already due is looked at at once, but not in a tight loop. */
const MIN_WAKE_MS = 50;

export type SignalState = "unknown" | "signal" | "no-signal";

export interface Watcher {
    attach(key: string, pipeline: Pipeline): void;
    detach(key: string): void;
    /** How many pipelines are attached. The poller runs while this is above zero. */
    readonly size: number;
    readonly running: boolean;
    readonly signal: SignalState;
    /** One look now, awaited. The loop calls this; tests call it directly. */
    tick(): Promise<void>;
    stop(): void;
}

export function createWatcher(deps: WatcherDeps): Watcher {
    const pipelines = new Map<string, Pipeline>();
    const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
    });
    const log = deps.log ?? (() => undefined);
    let cancelNext: (() => void) | null = null;
    let inFlight: AbortController | null = null;
    let looping = false;
    let signal: SignalState = "unknown";
    let misses = 0;

    /** How long until the next look: the pace, or sooner when a pending corner change is about to have held long enough. */
    function nextDelay(): number {
        let delay = deps.intervalMs;
        const now = deps.now();
        for (const pipeline of pipelines.values()) {
            const wake = pipeline.wakeAt();
            if (wake !== null) delay = Math.min(delay, Math.max(MIN_WAKE_MS, wake - now));
        }
        return delay;
    }

    const each = (fn: (pipeline: Pipeline) => void): void => {
        for (const [userId, pipeline] of pipelines) {
            try {
                fn(pipeline);
            } catch (error) {
                log(`[watch] ${userId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            }
        }
    };

    async function tick(): Promise<void> {
        const controller = new AbortController();
        inFlight = controller;
        const requestedAt = deps.now();
        let result: Snapshot;
        try {
            result = await deps.snapshot(controller.signal);
        } catch (error) {
            result = { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
        } finally {
            if (inFlight === controller) inFlight = null;
        }
        if (controller.signal.aborted || pipelines.size === 0) return;
        const now = deps.now();

        if (result.kind === "frame") {
            const grid = await deps.grid(result.jpeg);
            if (!grid) {
                log("[watch] a snapshot could not be read as an image");
                each((pipeline) => pipeline.look(null, now));
                return;
            }
            misses = 0;
            signal = "signal";
            const frame: Frame = { grid, jpeg: result.jpeg, capturedAt: requestedAt };
            each((pipeline) => pipeline.look(frame, now));
            return;
        }

        if (result.kind === "no-signal") {
            misses++;
            if (misses >= NO_SIGNAL_LOOKS) signal = "no-signal";
        }
        each((pipeline) => pipeline.look(null, now));
    }

    function loop(): void {
        if (!looping) return;
        void tick().finally(() => {
            if (looping) cancelNext = schedule(loop, nextDelay());
        });
    }

    function startLoop(): void {
        if (looping) return;
        looping = true;
        signal = "unknown";
        misses = 0;
        cancelNext = schedule(loop, 0);
    }

    function stopLoop(): void {
        looping = false;
        cancelNext?.();
        cancelNext = null;
        inFlight?.abort();
        inFlight = null;
    }

    return {
        attach(key, pipeline) {
            pipelines.set(key, pipeline);
            startLoop();
        },
        detach(key) {
            pipelines.delete(key);
            if (pipelines.size === 0) stopLoop();
        },
        get size() {
            return pipelines.size;
        },
        get running() {
            return looping;
        },
        get signal() {
            return signal;
        },
        tick,
        stop() {
            pipelines.clear();
            stopLoop();
        },
    };
}
