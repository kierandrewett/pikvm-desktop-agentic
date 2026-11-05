import { notificationBody } from "./alert-text";
import { createFastAlerts, type FastAlerts } from "./fast-alerts";
import { createSettler, maskZone, type Grid, type Settler, type ZoneCells } from "./frame-diff";
import { SCREEN_OCR_TIMEOUT_MS, SCREEN_TEXT_CHARS, type WatchLimits } from "./limits";
import type { ModelClient, ModelProvider } from "./models";
import { ModelError } from "./models";
import type { Ocr } from "./ocr";
import { cleanLines } from "./toast-rules";
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
 *
 * With the user's fast alerts on, `fast-alerts.ts` runs beside this on the same looks: it watches one corner for a pop-up.
 * This path then ignores that corner (its cells are blanked in the grid it compares), so a toast is told once, by the fast
 * path, and not again six seconds later by this one; everything outside the corner behaves as it does without fast alerts.
 */

export const NO_SIGNAL_TEXT = "The PiKVM has no video signal: the target is off, restarting or disconnected.";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Frame {
    grid: Grid;
    /** The snapshot as the PiKVM sent it. */
    jpeg: Buffer;
    /** Epoch ms at which the snapshot was requested: the frame cannot be older than this look. Absent in tests that do not time it. */
    capturedAt?: number;
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
    /** The crop of a frame to a rectangle of grid cells, for the OCR (fast alerts). Throws when it cannot be cut. */
    crop(jpeg: Buffer, cells: ZoneCells): Promise<Buffer>;
    /** The OCR fast alerts read pop-ups with, on this host. */
    ocr: Ocr;
    /** The OCR the whole-screen path reads a frame with when there is no OpenRouter key (its own process: a whole frame takes seconds, a pop-up must not wait for it). */
    screenOcr: Ocr;
    /** Put a pop-up's words in the check log (`PIKVM_WATCH_LOG_TEXT=1`). */
    logText?: boolean;
    /** Fast alerts may send a crop to the vision model when the OCR fails (`PIKVM_WATCH_FAST_CLOUD_FALLBACK=1`). The slow path is not affected. */
    cloudFallback?: boolean;
    log?(line: string): void;
}

export interface Pipeline {
    /**
     * One look at the screen, or `null` when there was none (no signal) so waiting work still gets its turn.
     * Never waits for a model: a check runs behind it. `slow` says whether this look is one of the whole-screen looks
     * (every `intervalMs`); a faster loop (fast alerts) makes the others, which only the fast path uses.
     */
    look(frame: Frame | null, now: number, slow?: boolean): void;
    /** The user's fast alerts are on: the shared poller looks at its faster pace while any pipeline says so. */
    wantsFast(): boolean;
    /** When a pending corner change will have held long enough, if one is pending: the shared poller makes a look then. */
    wakeAt(): number | null;
    /**
     * The signal went away (`lost`: a change worth a check), came back, or was already gone when this watch began
     * (`absent`: remembered, not announced).
     */
    signal(state: "lost" | "back" | "absent"): void;
    /** Resolves when no check is running and none is waiting to start. For tests and shutdown. */
    idle(): Promise<void>;
    status(): { settling: boolean; waiting: boolean; checking: boolean; alertPending: boolean; alertWaiting: boolean; alerting: boolean };
}

interface Change {
    kind: "change" | "signal-lost";
    score: number | null;
    frame: Frame | null;
    /** The frame the screen settled on before this change, used only when there is no description of it yet. */
    before: Frame | null;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
    const settler: Settler = createSettler({ settleMs: deps.limits.settleMs });
    let baseline: Frame | null = null;
    let description: string | null = null;
    let waiting: Change | null = null;
    let lastCheckAt = Number.NEGATIVE_INFINITY;
    let running: Promise<void> | null = null;
    const log = deps.log ?? (() => undefined);
    const fast: FastAlerts = createFastAlerts({
        userId: deps.userId,
        store: deps.store,
        push: deps.push,
        models: deps.models,
        provider: deps.provider,
        settings: deps.settings,
        limits: deps.limits.fast,
        now: deps.now,
        ocr: deps.ocr,
        crop: deps.crop,
        ...(deps.logText ? { logText: true } : {}),
        ...(deps.cloudFallback ? { cloudFallback: true } : {}),
        log,
    });
    /** What the whole-screen diff currently ignores: the fast alerts' zone, or nothing. A change of it starts that diff over. */
    let maskKey = "";

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
        if (!deps.provider() && deps.screenOcr.unavailable?.() !== undefined) {
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

    /**
     * A check with no OpenRouter key: the frame is read by the local OCR and its text, in reading order, is the description. With no
     * Jev there is nothing to judge a change by, so with no rule every settled change is reported (the minimum gap and the daily
     * cap still bound it); a rule cannot be judged and is logged as such. Nothing leaves the host.
     */
    async function checkLocal(change: Change): Promise<void> {
        const settings = deps.settings();
        const base = { kind: change.kind, score: change.score, rule: settings.rule } as const;
        if (settings.rule.trim() !== "") {
            return record({ ...base, outcome: "error", reason: "Your rule needs the OpenRouter key (Settings, Providers) to be judged, and there is none, so nothing was sent.", asked: false });
        }
        let read: CheckEntry["read"];
        try {
            let text: string;
            if (change.kind === "signal-lost" || !change.frame) {
                text = NO_SIGNAL_TEXT;
            } else {
                const ocr = await deps.screenOcr.read(await deps.prepare(change.frame.jpeg), SCREEN_OCR_TIMEOUT_MS);
                const lines = cleanLines(ocr.lines);
                text = lines.join(" ").slice(0, SCREEN_TEXT_CHARS).trim() || "The screen changed, and no text could be read on it.";
                read = { by: "ocr", ms: ocr.ms, chars: ocr.lines.join("\n").length, words: lines.join(" ").split(/\s+/).filter(Boolean).length, lines: ocr.lines.length };
                description = text;
            }
            const common = { ...base, asked: true, ...(read ? { read } : {}), ...(deps.logText ? { description: text } : {}) };
            const payload: PushPayload = { title: "PiKVM", body: notificationBody(text), tag: "pikvm-screen", url: "/app/", badge: 1 };
            try {
                const sent = await deps.push.send(deps.userId, payload);
                const push = { sent: sent.sent, removed: sent.removed, failed: sent.failed.length };
                if (sent.sent > 0) return record({ ...common, outcome: "pushed", push });
                return record({ ...common, outcome: "error", reason: `The screen was read but no notification was delivered: ${sent.failed[0]?.message ?? "every subscription had expired"}`, push });
            } catch (error) {
                return record({ ...common, outcome: "error", reason: `The screen was read but no notification was delivered: ${error instanceof Error ? error.message : "the push failed"}` });
            }
        } catch (error) {
            record({ ...base, outcome: "error", reason: error instanceof Error ? error.message : "the OCR failed", asked: true, ...(read ? { read } : {}) });
        }
    }

    async function check(change: Change): Promise<void> {
        const settings = deps.settings();
        const provider = deps.provider();
        const base = { kind: change.kind, score: change.score, rule: settings.rule, model: settings.visionModel } as const;
        if (!provider) return checkLocal(change);
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
            const payload: PushPayload = { title: "PiKVM", body: notificationBody(current), tag: "pikvm-screen", url: "/app/", badge: 1 };
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
        look(frame, now, slow = true) {
            if (frame) {
                fast.look(frame, now);
                const mask = fast.maskCells();
                const key = mask ? `${mask.x0},${mask.y0},${mask.x1},${mask.y1}` : "";
                if (key !== maskKey) {
                    maskKey = key;
                    settler.reset("adopt");
                }
                if (slow) {
                    const seen = settler.look(mask ? maskZone(frame.grid, mask) : frame.grid, now);
                    if (seen.state === "idle" && baseline === null) baseline = frame;
                    if (seen.state === "settled") {
                        const before = baseline;
                        baseline = frame;
                        admit({ kind: "change", score: seen.score, frame, before }, now);
                    }
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

        wantsFast: () => fast.on,

        wakeAt: () => fast.wakeAt,

        async idle() {
            while (running) await running;
            await fast.idle();
        },

        status: () => ({ settling: settler.pending, waiting: waiting !== null, checking: running !== null, ...fast.status() }),
    };
}
