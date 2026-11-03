import { createSettler, type Grid, type Settler } from "./frame-diff";
import type { WatchLimits } from "./limits";
import type { ModelClient, ModelProvider } from "./models";
import { ModelError } from "./models";
import { PushError, type Push, type PushPayload } from "./push";
import type { CheckEntry, WatchSettings } from "@pikvm/contracts/watch";
import type { WatchStore } from "./store";

/**
 * One user's watch, below the shared poller: the settle detector, then the model check, then the push.
 *
 * Nothing here runs a model unless the screen changed and then held still (frame-diff.ts). A settled change is one
 * "check": it describes the new frame with the image model (and the frame before it, once, if no description exists
 * yet), asks Jev whether the change matters to this person's rule, and pushes only on a decisive yes.
 *
 * Bounds that hold whatever the screen does: at most one check per `minCheckGapMs` (a change inside the gap waits,
 * the newest one only), at most `dailyCap` checks in any 24 hours (counted from the log, so a restart does not reset
 * it), one check at a time. Every change that reaches this far leaves a line in the log, with the reason when no model was asked.
 */

export const NO_SIGNAL_TEXT = "The PiKVM has no video signal: the target is off, restarting or disconnected.";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Frame {
    grid: Grid;
    /** The snapshot as the PiKVM sent it. */
    jpeg: Buffer;
}

export interface PipelineDeps {
    userId: string;
    store: WatchStore;
    push: Push;
    models: ModelClient;
    /** The user's OpenRouter provider right now; undefined when the key is gone. */
    provider(): ModelProvider | undefined;
    settings(): WatchSettings;
    limits: WatchLimits;
    now(): number;
    /** Scale a frame for the model. */
    prepare(jpeg: Buffer): Promise<Buffer>;
    log?(line: string): void;
}

export interface Pipeline {
    /**
     * One look at the screen, or `null` when there was none (no signal) so waiting work still gets its turn.
     * Never waits for a model: a check runs behind it.
     */
    look(frame: Frame | null, now: number): void;
    /**
     * The signal went away (`lost`: a change worth a check), came back, or was already gone when this watch began
     * (`absent`: remembered, not announced).
     */
    signal(state: "lost" | "back" | "absent"): void;
    /** Resolves when no check is running and none is waiting to start. For tests and shutdown. */
    idle(): Promise<void>;
    status(): { settling: boolean; waiting: boolean; checking: boolean };
}

interface Change {
    kind: "change" | "signal-lost";
    score: number | null;
    frame: Frame | null;
    /** The frame the screen settled on before this change, used only when there is no description of it yet. */
    before: Frame | null;
}

/** The first sentence of a description, short enough for a notification's body. */
export function notificationBody(description: string): string {
    const first = description.split(/(?<=[.!?])\s+/)[0] ?? description;
    return first.length <= 160 ? first : `${first.slice(0, 157).trimEnd()}...`;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
    const settler: Settler = createSettler({ settleMs: deps.limits.settleMs });
    let baseline: Frame | null = null;
    let description: string | null = null;
    let waiting: Change | null = null;
    let lastCheckAt = Number.NEGATIVE_INFINITY;
    let running: Promise<void> | null = null;
    const log = deps.log ?? (() => undefined);

    function record(entry: Omit<CheckEntry, "t" | "at">): void {
        const t = deps.now();
        try {
            deps.store.append(deps.userId, { t, at: new Date(t).toISOString(), ...entry });
        } catch (error) {
            log(`[watch] could not write the check log: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function start(change: Change, now: number): void {
        lastCheckAt = now;
        running = check(change)
            .catch((error: unknown) => log(`[watch] check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
            .finally(() => {
                running = null;
            });
    }

    /** Run, defer or drop a change, in that order of preference. */
    function admit(change: Change, now: number): void {
        const settings = deps.settings();
        if (!deps.provider()) {
            record({ kind: change.kind, score: change.score, outcome: "skipped", reason: "no OpenRouter key in Settings, Providers", asked: false, rule: settings.rule });
            return;
        }
        if (running || now - lastCheckAt < deps.limits.minCheckGapMs) {
            if (waiting) {
                record({ kind: waiting.kind, score: waiting.score, outcome: "skipped", reason: "replaced by a newer change before the minimum gap between checks ended", asked: false, rule: settings.rule });
            }
            waiting = change;
            return;
        }
        const used = deps.store.askedSince(deps.userId, now - DAY_MS);
        if (used >= deps.limits.dailyCap) {
            record({ kind: change.kind, score: change.score, outcome: "skipped", reason: `daily cap of ${deps.limits.dailyCap} checks reached`, asked: false, rule: settings.rule });
            return;
        }
        start(change, now);
    }

    async function check(change: Change): Promise<void> {
        const settings = deps.settings();
        const provider = deps.provider();
        const base = { kind: change.kind, score: change.score, rule: settings.rule, model: settings.visionModel } as const;
        if (!provider) return;
        let asked = false;
        let costUsd = 0;
        let previous = description;
        try {
            if (previous === null) {
                if (!change.before) {
                    previous = "(nothing was seen before this)";
                } else {
                    asked = true;
                    const before = await deps.models.describe(provider, settings.visionModel, await deps.prepare(change.before.jpeg));
                    costUsd += before.costUsd ?? 0;
                    previous = before.text;
                }
            }
            let current: string;
            if (change.kind === "signal-lost" || !change.frame) {
                current = NO_SIGNAL_TEXT;
            } else {
                asked = true;
                const now = await deps.models.describe(provider, settings.visionModel, await deps.prepare(change.frame.jpeg));
                costUsd += now.costUsd ?? 0;
                current = now.text;
            }
            asked = true;
            const decision = await deps.models.decide(provider, { previous, current, rule: settings.rule });
            costUsd += decision.costUsd ?? 0;
            description = current;
            const common = {
                ...base,
                asked,
                previous,
                description: current,
                noul: decision.noul,
                ...(decision.cached ? { fromCache: true } : {}),
                ...(costUsd > 0 ? { costUsd } : {}),
            };
            if (decision.verdict === "no") return record({ ...common, outcome: "no" });
            if (decision.verdict === "undecided") return record({ ...common, outcome: "undecided", reason: "Jev's answer was not decisive, so nothing was sent" });
            const payload: PushPayload = { title: "PiKVM", body: notificationBody(current), tag: "pikvm-screen", url: "/app/" };
            try {
                const sent = await deps.push.send(deps.userId, payload);
                const push = { sent: sent.sent, removed: sent.removed, failed: sent.failed.length };
                if (sent.sent > 0) return record({ ...common, outcome: "pushed", push });
                const why = sent.failed[0]?.message ?? "every subscription had expired";
                return record({ ...common, outcome: "error", reason: `Jev said yes but no notification was delivered: ${why}`, push });
            } catch (error) {
                const reason = error instanceof PushError ? error.message : error instanceof Error ? error.message : "the push failed";
                return record({ ...common, outcome: "error", reason: `Jev said yes but no notification was delivered: ${reason}` });
            }
        } catch (error) {
            const reason = error instanceof ModelError || error instanceof Error ? error.message : "the model call failed";
            record({ ...base, outcome: "error", reason, asked, ...(costUsd > 0 ? { costUsd } : {}), ...(previous ? { previous } : {}) });
        }
    }

    return {
        look(frame, now) {
            if (frame) {
                const seen = settler.look(frame.grid, now);
                if (seen.state === "idle" && baseline === null) baseline = frame;
                if (seen.state === "settled") {
                    const before = baseline;
                    baseline = frame;
                    admit({ kind: "change", score: seen.score, frame, before }, now);
                }
            }
            if (waiting && !running && now - lastCheckAt >= deps.limits.minCheckGapMs) {
                const change = waiting;
                waiting = null;
                admit(change, now);
            }
        },

        signal(state) {
            if (state === "back") {
                settler.reset("changed");
                return;
            }
            if (state === "absent") {
                description = NO_SIGNAL_TEXT;
                return;
            }
            admit({ kind: "signal-lost", score: null, frame: null, before: baseline }, deps.now());
        },

        async idle() {
            while (running) await running;
        },

        status: () => ({ settling: settler.pending, waiting: waiting !== null, checking: running !== null }),
    };
}
