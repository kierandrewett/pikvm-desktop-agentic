/**
 * The driver of the connection monitor: the one timer, the one probe at a time, and the page's own events. All rules are in
 * machine.ts. The monitor is app-wide and made once (`appMonitor`); a test makes its own with a fake clock and probe.
 */

import { loadDrops, saveDrops } from "./drops";
import { createConnectionMachine, PROBE_TIMEOUT_MS, SLOW_MS, type ConnectionMachine, type Outage } from "./machine";
import { probeHost } from "./probe";

export interface ConnectionMonitorOptions {
    readonly now?: () => number;
    readonly probe?: (signal: AbortSignal) => Promise<void>;
    readonly storage?: Storage | undefined;
    /** How often the monitor looks at the clock, in ms. */
    readonly tickMs?: number;
}

/**
 * Another channel to the host that is not in the browser's connection queue (the event WebSocket): proof that the host is alive
 * that a starved probe cannot give.
 */
export interface Liveness {
    /** Ask the channel to answer now: how long it took in ms, or null if it did not within `timeoutMs` (or is not open). */
    ping(timeoutMs: number): Promise<number | null>;
}

export interface ConnectionMonitor {
    readonly machine: ConnectionMachine;
    /** Give the monitor a second channel to judge a probe by. Returns the function that takes it away. */
    setLiveness(liveness: Liveness): () => void;
    /** Called when an outage ends (not for a slow spell). Returns the function that stops listening. */
    onRecovered(listener: (outage: Outage & { readonly endedAt: number }) => void): () => void;
    /** Start probing and listening. Returns the function that stops. */
    start(): () => void;
}

export function createConnectionMonitor(options: ConnectionMonitorOptions = {}): ConnectionMonitor {
    const now = options.now ?? Date.now;
    const probe = options.probe ?? probeHost;
    const storage = options.storage;
    const recovered = new Set<(outage: Outage & { readonly endedAt: number }) => void>();
    const machine = createConnectionMachine({
        now,
        outages: loadDrops(storage),
        onOutagesChange: (ended) => saveDrops(storage, ended),
        onRecovered: (outage) => {
            for (const listener of [...recovered]) listener(outage);
        },
    });

    let liveness: Liveness | null = null;
    let running = 0;
    let stop: (() => void) | null = null;

    const begin = (): (() => void) => {
        let alive = true;
        let abortProbe = (): void => {};

        /** How long the other channel took to answer a ping, or null. It is never in the browser's connection queue. */
        const pongRoundTrip = (): Promise<number | null> =>
            liveness === null ? Promise.resolve(null) : liveness.ping(PROBE_TIMEOUT_MS).catch(() => null);

        const runProbe = async (): Promise<void> => {
            machine.probeStarted();
            const startedAt = now();
            const pong = pongRoundTrip();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            abortProbe = () => controller.abort();
            let ok = false;
            try {
                await probe(controller.signal);
                ok = true;
            } catch {
                // judged below
            } finally {
                clearTimeout(timer);
            }
            const ms = now() - startedAt;
            if (!alive) return machine.probeAbandoned();
            if (ok && ms <= SLOW_MS) return machine.probeSucceeded(ms);
            // Not good and quick: the other channel says what was wrong. A quick answer there means the host is fine and the probe
            // was held up in the browser (unknown). A slow answer there is a slow host. No answer there leaves the probe's own verdict.
            const rtt = await pong;
            if (!alive) return machine.probeAbandoned();
            if (rtt !== null && rtt <= SLOW_MS) return machine.probeUnknown();
            if (rtt !== null) return machine.probeSucceeded(rtt);
            if (ok) machine.probeSucceeded(ms);
            else machine.probeFailed(ms);
        };

        const step = (): void => {
            machine.tick();
            if (alive && machine.probeDue()) void runProbe();
        };

        const onOffline = (): void => machine.deviceOffline();
        const onOnline = (): void => {
            machine.deviceOnline();
            step();
        };
        const onVisibility = (): void => {
            machine.setHidden(document.hidden);
            step();
        };

        machine.setHidden(document.hidden);
        if (navigator.onLine === false) machine.deviceOffline();
        addEventListener("offline", onOffline);
        addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVisibility);
        const interval = setInterval(step, options.tickMs ?? 1000);
        step();

        return () => {
            alive = false;
            abortProbe();
            clearInterval(interval);
            removeEventListener("offline", onOffline);
            removeEventListener("online", onOnline);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    };

    return {
        machine,
        onRecovered(listener) {
            recovered.add(listener);
            return () => recovered.delete(listener);
        },
        setLiveness(channel) {
            liveness = channel;
            return () => {
                if (liveness === channel) liveness = null;
            };
        },
        start() {
            // Counted: the shell's strict-mode double mount must not leave two timers or none.
            running += 1;
            if (running === 1) stop = begin();
            return () => {
                running -= 1;
                if (running === 0) {
                    stop?.();
                    stop = null;
                }
            };
        },
    };
}

let shared: ConnectionMonitor | null = null;

/** The app's one monitor, made on first use; its outages live in this tab's sessionStorage. */
export function appMonitor(): ConnectionMonitor {
    shared ??= createConnectionMonitor({ storage: typeof sessionStorage === "undefined" ? undefined : sessionStorage });
    return shared;
}
