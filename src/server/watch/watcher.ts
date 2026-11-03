import type { Grid } from "./frame-diff";
import { NO_SIGNAL_LOOKS } from "./limits";
import type { Pipeline } from "./pipeline";

/**
 * The one poller for the PiKVM, shared by every user whose watch is on.
 *
 * It takes a snapshot every `intervalMs` (and only while somebody's watch is attached: the last one to leave stops it),
 * reduces it to a grey grid once, and hands the same frame to each user's pipeline. A look that finds no signal or no
 * PiKVM hands nothing on (so the screen going black is not mistaken for a change) but tells the pipelines when the signal
 * has really gone (two looks running) and when it is back.
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

export type SignalState = "unknown" | "signal" | "no-signal";

export interface Watcher {
    attach(userId: string, pipeline: Pipeline): void;
    detach(userId: string): void;
    /** How many users are attached. The poller runs while this is above zero. */
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
            if (signal === "no-signal") each((pipeline) => pipeline.signal("back"));
            signal = "signal";
            each((pipeline) => pipeline.look({ grid, jpeg: result.jpeg }, now));
            return;
        }

        if (result.kind === "no-signal") {
            misses++;
            if (misses >= NO_SIGNAL_LOOKS && signal !== "no-signal") {
                const announce = signal === "signal";
                signal = "no-signal";
                each((pipeline) => pipeline.signal(announce ? "lost" : "absent"));
            }
        }
        each((pipeline) => pipeline.look(null, now));
    }

    function loop(): void {
        if (!looping) return;
        void tick().finally(() => {
            if (looping) cancelNext = schedule(loop, deps.intervalMs);
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
        attach(userId, pipeline) {
            pipelines.set(userId, pipeline);
            if (signal === "no-signal") pipeline.signal("absent");
            startLoop();
        },
        detach(userId) {
            pipelines.delete(userId);
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
