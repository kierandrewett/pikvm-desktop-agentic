import type { CheckEntry, CheckLatency, WatchSettings } from "@pikvm/contracts/watch";
import { changedBox, createZoneSettler, zoneCells, type Frame, type ZoneCells, type ZoneSettler } from "./frame-diff";
import { failOpenBody, judgePopup, readFacts, type Ask, type Facts, type StepResult, type Verdict } from "./judge";
import {
    ALERT_TTL_SEC,
    CALL_TTL_SEC,
    DIALOG_SCORE,
    DUPLICATE_MS,
    MAX_WAITING_POPUPS,
    OCR_PAD_CELLS,
    OCR_TIMEOUT_MS,
    ZONE_CHANGE_FRACTION,
    ZONE_MAX_FRACTION,
    type WatchLimits,
} from "./limits";
import { decisionRequest } from "./prompts";
import { OcrTimeoutError, type Ocr, type OcrResult } from "./ocr";
import { PushError, type Push, type PushPayload } from "./push";
import type { WatchStore } from "./store";
import { cleanLines, MIN_TOAST_WORDS, readToast, toastHash } from "./toast-rules";

/**
 * One user's watch, below the shared poller: a pop-up in one corner of the screen, from the look that sees it to the push.
 * docs/deploy-web.md ("Screen watch") has the flow and the numbers.
 *
 * Zone diff, then a crop, then OCR on this host, then text rules, then (when the user has a chat model) two small requests to it, then
 * the push. What it is, rule by rule:
 *  - it watches one rectangle (the zone) of the grey grid;
 *  - a change counts as a pop-up once it has held `settleMs` (1.2 s), and is not dropped if it goes away afterwards: it is read from the
 *    look that confirmed it, or, if it had gone again by then, from the last look that saw it;
 *  - only the cells that changed (the pop-up and a margin) are cropped and read;
 *  - its own gap (4 s) and daily cap (500), so two pop-ups 5 s apart both notify;
 *  - the same pop-up text inside `DUPLICATE_MS` is told once;
 *  - the chat model gets the OCR text (never the picture) in two steps (prompts.ts, judge.ts): READ writes down everything the pop-up
 *    shows, JUDGE decides from those facts whether it is worth interrupting the person for and writes the notification (the user's rule
 *    is part of the JUDGE step only). Each step has its own hard time limit inside one budget (limits.ts). READ failing leaves the
 *    JUDGE the OCR lines as read; JUDGE failing sends the notification anyway (fail open), as the facts' text or else the rules' own
 *    text. A call never waits for the model. Without a chat model there is no network call at all and the notification is the text as read.
 * Every check logs the timestamps of its path and fixed words for the model's steps, and never the screen's words (unless the host runs with
 * `PIKVM_WATCH_LOG_TEXT=1`, which adds the OCR text) and never what the chat model wrote, whatever the host runs with.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The user's chat model, as the watch uses it. */
export interface AlertModel {
    /** A model is configured and its provider can be called. */
    available(): boolean;
    /**
     * One request, answered with JSON where the provider has a JSON mode; undefined when there is no model to ask. Rejects on failure or
     * after `options.timeoutMs`.
     */
    ask: Ask;
    /**
     * The Decisions model, when one is set: P(yes) that the owner needs to know. Undefined when none is set. Rejects on failure or after
     * `options.timeoutMs`. Only used to screen out plain noise before `ask` is spent (see `SKIP_BELOW`).
     */
    decide?(
        request: { state: Record<string, string>; instructions: string },
        options: { timeoutMs: number },
    ): Promise<{ probability: number; backend: "decisions" | "chat" } | undefined>;
    /** A Decisions model is set and can be called. */
    decides?(): boolean;
}

/** A Decisions answer at or below this is a confident no: nothing is read, judged or sent. Anything higher, or no answer, goes on. */
export const SKIP_BELOW = 0.15;

export interface AlertsDeps {
    userId: string;
    store: WatchStore;
    push: Push;
    settings(): WatchSettings;
    limits: WatchLimits;
    now(): number;
    ocr: Ocr;
    model: AlertModel;
    /** The crop of a frame to a rectangle of grid cells, as a JPEG. Throws when it cannot be cut. */
    crop(jpeg: Buffer, cells: ZoneCells): Promise<Buffer>;
    /** The person is at the screen right now (see presence.ts): nothing is asked of a model or pushed while this is true. Default: never. */
    userActive?(): boolean;
    /** Put a pop-up's words in the check log. Off unless the operator asks (`PIKVM_WATCH_LOG_TEXT=1`). */
    logText?: boolean;
    log?(line: string): void;
}

export interface Alerts {
    /** One look at the screen, or `null` when there was none (no signal) so waiting work still gets its turn. Never waits for OCR or a model. */
    look(frame: Frame | null, now: number): void;
    /** When a pending change will have held long enough, if one is pending: the moment worth an extra look. */
    wakeAt(): number | null;
    /** Resolves when no check is running and none is waiting to start. For tests and shutdown. */
    idle(): Promise<void>;
    status(): { pending: boolean; waiting: boolean; checking: boolean };
}

interface Appearance {
    score: number;
    frame: Frame;
    /** The cells to read: what changed, widened, inside the zone. */
    region: ZoneCells;
    /** The cells that changed, without the margin: the pop-up itself. Text the OCR finds outside it is the window behind. */
    core: ZoneCells;
    firstSeenAt: number;
    detectedAt: number;
}

const wordCount = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length, 0);

/**
 * The lines of an OCR result that lie inside the pop-up (the cells that changed), when the engine says where each line was. A pop-up
 * over a page of text has the page's text in the margin around it. If nothing is inside all lines are kept rather than none.
 */
function onlyPopup(ocr: OcrResult, change: Appearance): string[] {
    const { region, core } = change;
    if (!ocr.boxes || ocr.boxes.length !== ocr.lines.length) return ocr.lines;
    const width = region.x1 - region.x0;
    const height = region.y1 - region.y0;
    const slack = 0.02;
    const inside = ocr.lines.filter((_, i) => {
        const box = ocr.boxes![i]!;
        const x = (((box.x0 + box.x1) / 2) * width + region.x0 - core.x0) / (core.x1 - core.x0);
        const y = (((box.y0 + box.y1) / 2) * height + region.y0 - core.y0) / (core.y1 - core.y0);
        return x >= -slack && x <= 1 + slack && y >= -slack && y <= 1 + slack;
    });
    return inside.length > 0 ? inside : ocr.lines;
}

/**
 * A model step that failed in a way another try can fix (the model errored, or answered with nothing usable) gets one more try. A timeout
 * does not: it already waited its whole limit. The time of both tries is reported.
 */
async function withRetry<T>(run: () => Promise<StepResult<T>>): Promise<StepResult<T>> {
    const first = await run();
    if (first.ok || first.failure === "timeout") return first;
    const second = await run();
    return { ...second, ms: first.ms + second.ms };
}

export function createAlerts(deps: AlertsDeps): Alerts {
    const zone: ZoneSettler = createZoneSettler({ settleMs: deps.limits.settleMs, changeFraction: ZONE_CHANGE_FRACTION });
    const log = deps.log ?? (() => undefined);
    /** The zone the settler's picture belongs to; a different zone starts it over. */
    let zoneKey = "";
    /** The frame of the last look at which the zone changed: what a pop-up that is gone by the confirming look is read from. */
    let detection: Frame | null = null;
    /** Pop-ups that came while a check was running or inside the gap, oldest first. */
    const waiting: Appearance[] = [];
    let lastCheckAt = Number.NEGATIVE_INFINITY;
    let running: Promise<void> | null = null;
    /** Hash of a pop-up's text -> when it was notified. */
    const notified = new Map<string, number>();

    function record(entry: Omit<CheckEntry, "t" | "at" | "kind">): void {
        const t = deps.now();
        try {
            deps.store.append(deps.userId, { t, at: new Date(t).toISOString(), kind: "alert", ...entry });
        } catch (error) {
            log(`[watch] could not write the check log: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const latencyOf = (change: Appearance): CheckLatency => ({
        firstSeenAt: change.firstSeenAt,
        capturedAt: change.frame.capturedAt ?? change.detectedAt,
        detectedAt: change.detectedAt,
    });

    function start(change: Appearance, now: number): void {
        lastCheckAt = now;
        running = check(change)
            .catch((error: unknown) => log(`[watch] check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
            .finally(() => {
                running = null;
            });
    }

    const skipped = (reason: string, about: Appearance): void =>
        record({ score: about.score, outcome: "skipped", reason, asked: false, rule: deps.settings().rule, latency: latencyOf(about) });

    /** Start a check now, unless the day's cap is spent. */
    function begin(change: Appearance, now: number): void {
        if (deps.store.askedSince(deps.userId, now - DAY_MS) >= deps.limits.dailyCap) {
            return skipped(`daily cap of ${deps.limits.dailyCap} checks reached`, change);
        }
        start(change, now);
    }

    /** Run a pop-up now, or queue it behind the ones already waiting (oldest first). Only one that finds the queue full is dropped. */
    function admit(change: Appearance, now: number): void {
        if (running || waiting.length > 0 || now - lastCheckAt < deps.limits.minCheckGapMs) {
            if (waiting.length >= MAX_WAITING_POPUPS) return skipped("too many pop-ups waiting to be read", change);
            waiting.push(change);
            return;
        }
        begin(change, now);
    }

    async function check(change: Appearance): Promise<void> {
        const settings = deps.settings();
        const latency = latencyOf(change);
        const base = { score: change.score, rule: settings.rule, latency } as const;
        let read: CheckEntry["read"];
        let text: string[] = [];
        /** Held back: the person is using the app's window. Logged as its own outcome, with no pop-up text, and nothing more is done. */
        const held = (): void =>
            record({ ...base, asked: read !== undefined, ...(read ? { read } : {}), outcome: "held", reason: "you are using this window" });
        const present = (): boolean => deps.userActive?.() === true;
        try {
            // Checked first: a pop-up that appears while the person is at the screen is not read at all. Again before the model is asked and
            // again just before the push, because a pop-up can wait in the gap, and reading and asking take time.
            if (present()) return held();
            const crop = await deps.crop(change.frame.jpeg, change.region);

            let ocr: OcrResult | undefined;
            let ocrFailure: string | undefined;
            try {
                ocr = await deps.ocr.read(crop, OCR_TIMEOUT_MS);
            } catch (error) {
                ocrFailure = error instanceof OcrTimeoutError ? "ocr timed out" : `ocr failed: ${error instanceof Error ? error.message : String(error)}`;
            }
            latency.readAt = deps.now();
            // The margin around the pop-up is read too, so a pop-up's edge text is not cut; what the OCR finds there is the window behind it.
            const lines = ocr ? onlyPopup(ocr, change) : [];
            const toast = ocr ? readToast(lines) : null;
            // The words of the pop-up itself: a clock, a close glyph and a button's label are not counted.
            const words = wordCount(cleanLines(lines));
            if (ocr) {
                read = { ms: ocr.ms, chars: lines.join("\n").length, words, lines: lines.length };
                text = lines;
            }
            const common = () => ({
                ...base,
                asked: true,
                ...(read ? { read } : {}),
                ...(deps.logText && text.length > 0 ? { description: text.join("\n") } : {}),
            });
            if (ocrFailure !== undefined) return record({ ...common(), outcome: "error", reason: `${ocrFailure}, so nothing was sent` });
            if (!toast) {
                const dialog = change.score >= DIALOG_SCORE;
                return record({
                    ...common(),
                    outcome: "skipped",
                    reason: dialog
                        ? `the OCR read ${words} words (fewer than ${MIN_TOAST_WORDS}) in a change big enough to be a dialog, so nothing was sent`
                        : `The corner had no readable text (${words} words read), so nothing was sent.`,
                });
            }

            const hash = toastHash(`${toast.title} ${toast.body}`);
            const before = notified.get(hash);
            if (before !== undefined && deps.now() - before < DUPLICATE_MS) {
                const seconds = Math.round((deps.now() - before) / 1000);
                return record({ ...common(), outcome: "skipped", reason: `The same pop-up text was notified ${seconds} seconds ago, so it was not sent again.` });
            }

            // The chat model, if there is one: the OCR text in (never the picture), in two steps (see `consult`). A call never waits for it.
            // Whatever it does, the log gets numbers and fixed words, never its text.
            let body = toast.body;
            let title = toast.title;
            /** Whether the notification is the rules' own words (the OCR's text) and not the model's. Only those may be logged, and only on request. */
            let ownWords = true;
            let judged: CheckEntry["judged"];
            if (present()) return held();
            let decided: CheckEntry["decided"];
            if (toast.kind !== "call" && deps.model.decide && deps.model.decides?.()) {
                const started = deps.now();
                try {
                    const answer = await deps.model.decide(decisionRequest(toast.lines, settings.rule), { timeoutMs: deps.limits.judgeTimeoutMs });
                    if (answer) decided = { ms: deps.now() - started, probability: answer.probability, backend: answer.backend };
                } catch {
                    decided = { ms: deps.now() - started, failed: true };
                }
                if (present()) return held();
                if (decided?.probability !== undefined && decided.probability <= SKIP_BELOW) {
                    return record({ ...common(), decided, outcome: "no" });
                }
            }
            if (toast.kind !== "call" && deps.model.available()) {
                const consulted = await consult(toast.lines, settings.rule, latency);
                if (consulted === "held") return held();
                judged = consulted.judged;
                if (consulted.verdict && !consulted.verdict.notify) return record({ ...common(), judged, ...(decided ? { decided } : {}), outcome: "no" });
                if (consulted.verdict) {
                    body = consulted.verdict.body;
                    title = consulted.verdict.title ?? toast.title;
                    ownWords = false;
                } else if (consulted.facts) {
                    // The judge failed: fail open, with the facts' text.
                    body = failOpenBody(consulted.facts, toast.body);
                    ownWords = body === toast.body;
                }
            }

            if (present()) return held();
            const ttlSec = toast.kind === "call" ? CALL_TTL_SEC : ALERT_TTL_SEC;
            const payload: PushPayload = { title, body, tag: toast.tag, url: "/app/", badge: 1 };
            const done = { ...common(), ...(judged ? { judged } : {}), ...(decided ? { decided } : {}) };
            try {
                const sent = await deps.push.send(deps.userId, payload, { urgency: toast.urgency, ttlSeconds: ttlSec });
                latency.pushedAt = deps.now();
                latency.totalMs = latency.pushedAt - latency.capturedAt;
                latency.sinceFirstSeenMs = latency.pushedAt - latency.firstSeenAt;
                const push = { sent: sent.sent, removed: sent.removed, failed: sent.failed.length };
                if (sent.sent > 0) {
                    notified.set(hash, latency.pushedAt);
                    for (const [key, at] of notified) if (latency.pushedAt - at >= DUPLICATE_MS) notified.delete(key);
                    const facts = {
                        kind: toast.kind,
                        tag: toast.tag,
                        urgency: toast.urgency,
                        ttlSec,
                        titleChars: title.length,
                        bodyChars: body.length,
                        ...(deps.logText && ownWords ? { title, body } : {}),
                    };
                    return record({ ...done, outcome: "pushed", push, notified: facts });
                }
                const why = sent.failed[0]?.message ?? "every subscription had expired";
                return record({ ...done, outcome: "error", reason: `The pop-up was read but no notification was delivered: ${why}`, push });
            } catch (error) {
                const reason = error instanceof PushError ? error.message : error instanceof Error ? error.message : "the push failed";
                return record({ ...done, outcome: "error", reason: `The pop-up was read but no notification was delivered: ${reason}` });
            }
        } catch (error) {
            record({ ...base, outcome: "error", reason: error instanceof Error ? error.message : "the check failed", asked: true, ...(read ? { read } : {}) });
        }
    }

    /**
     * The chat model's two steps on one pop-up. READ first: the OCR lines to facts. Then JUDGE: the facts (or, when READ gave nothing
     * usable, the lines as read) and the person's rule to a verdict. Each step runs to the end however slow the model is: its limit is
     * only a hang guard, and a step that errored or answered with something unusable gets one more try. "held" when the person came to
     * the screen in between. A step that fails is in `judged` as a fixed word; what to do about it is the caller's: no verdict means
     * notify anyway.
     */
    async function consult(
        lines: readonly string[],
        rule: string,
        latency: CheckLatency,
    ): Promise<"held" | { judged: NonNullable<CheckEntry["judged"]>; facts?: Facts; verdict?: Verdict }> {
        const { readTimeoutMs, judgeTimeoutMs } = deps.limits;
        const read = await withRetry(() => readFacts(deps.model.ask, lines, readTimeoutMs, deps.now));
        latency.factsAt = deps.now();
        if (deps.userActive?.() === true) return "held";
        const judge = await withRetry(() => judgePopup(deps.model.ask, read.ok ? read.value : lines, rule, judgeTimeoutMs, deps.now));
        latency.judgedAt = deps.now();
        return {
            judged: {
                readMs: read.ms,
                ...(read.ok ? {} : { readSkipped: read.failure }),
                judgeMs: judge.ms,
                ...(judge.ok ? { notify: judge.value.notify, reason: judge.value.reason } : { judgeSkipped: judge.failure }),
            },
            ...(read.ok ? { facts: read.value } : {}),
            ...(judge.ok ? { verdict: judge.value } : {}),
        };
    }

    return {
        wakeAt: () => zone.wakeAt,

        look(frame, now) {
            const settings = deps.settings();
            const key = JSON.stringify(settings.alertZone);
            if (key !== zoneKey) {
                zoneKey = key;
                zone.reset();
                waiting.length = 0;
                detection = null;
            }
            if (frame) {
                const cells = zoneCells(settings.alertZone);
                const seen = zone.look(frame.grid, cells, now);
                if (seen.state === "changing") detection = frame;
                if (seen.state === "appeared" && seen.score > ZONE_MAX_FRACTION) {
                    detection = null;
                    const big = Math.round(seen.score * 100);
                    record({
                        score: seen.score,
                        outcome: "skipped",
                        reason: `${big}% of the corner changed: that is a window or the whole screen changing, not a pop-up, so it was not read.`,
                        asked: false,
                        rule: settings.rule,
                        latency: { firstSeenAt: seen.firstSeenAt, capturedAt: frame.capturedAt ?? now, detectedAt: now },
                    });
                } else if (seen.state === "appeared") {
                    // Read the look that confirmed it, or the look that saw it when it is gone again by now.
                    const source = seen.source === "confirmed" ? frame : (detection ?? frame);
                    detection = null;
                    admit(
                        {
                            score: seen.score,
                            frame: source,
                            region: changedBox(seen.quiet, seen.grid, cells, OCR_PAD_CELLS),
                            core: changedBox(seen.quiet, seen.grid, cells, 0),
                            firstSeenAt: seen.firstSeenAt,
                            detectedAt: now,
                        },
                        now,
                    );
                } else if (seen.state !== "changing") {
                    detection = null;
                }
            }
            if (waiting.length > 0 && !running && now - lastCheckAt >= deps.limits.minCheckGapMs) begin(waiting.shift()!, now);
        },

        async idle() {
            while (running) await running;
        },

        status: () => ({ pending: zone.wakeAt !== null, waiting: waiting.length > 0, checking: running !== null }),
    };
}
