import type { CheckEntry, CheckLatency, WatchSettings } from "@pikvm/contracts/watch";
import { changedBox, createZoneSettler, zoneCells, type Frame, type ZoneCells, type ZoneSettler } from "./frame-diff";
import {
    ALERT_TTL_SEC,
    CALL_TTL_SEC,
    DIALOG_SCORE,
    DUPLICATE_MS,
    OCR_PAD_CELLS,
    OCR_TIMEOUT_MS,
    SUMMARY_TIMEOUT_MS,
    ZONE_CHANGE_FRACTION,
    ZONE_MAX_FRACTION,
    type WatchLimits,
} from "./limits";
import { OcrTimeoutError, type Ocr, type OcrResult } from "./ocr";
import { PushError, type Push, type PushPayload } from "./push";
import type { WatchStore } from "./store";
import { parseAnswer, summaryRequest } from "./summary";
import { cleanLines, MIN_TOAST_WORDS, readToast, toastHash } from "./toast-rules";

/**
 * One user's watch, below the shared poller: a pop-up in one corner of the screen, from the look that sees it to the push.
 * docs/deploy-web.md ("Screen watch") has the flow and the numbers.
 *
 * Zone diff, then a crop, then OCR on this host, then text rules, then (when the user has a chat model) one small request to it, then
 * the push. What it is, rule by rule:
 *  - it watches one rectangle (the zone) of the grey grid;
 *  - a change counts as a pop-up once it has held `settleMs` (1.2 s), and is not dropped if it goes away afterwards: it is read from the
 *    look that confirmed it, or, if it had gone again by then, from the last look that saw it;
 *  - only the cells that changed (the pop-up and a margin) are cropped and read;
 *  - its own gap (4 s) and daily cap (500), so two pop-ups 5 s apart both notify;
 *  - the same pop-up text inside `DUPLICATE_MS` is told once;
 *  - the chat model gets the OCR text (never the picture) and writes the notification as one sentence; with a rule it also answers SKIP for
 *    a pop-up that is not what the rule asks about. Past 2.5 s, on an error or an unusable answer, the notification is the rules' own
 *    text (with a rule: it is sent, a rule that could not be applied is not a reason to miss it). A call never waits for the model.
 *    Without a chat model there is no network call at all and the notification is the text as read.
 * Every check logs the timestamps of its path and never the screen's words (unless the host runs with `PIKVM_WATCH_LOG_TEXT=1`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The user's chat model, as the watch uses it. */
export interface AlertModel {
    /** A model is configured and its provider can be called. */
    available(): boolean;
    /** One request; undefined when there is no model to ask. Rejects on failure or after `timeoutMs`. */
    ask(system: string, user: string, timeoutMs: number): Promise<string | undefined>;
}

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

export function createAlerts(deps: AlertsDeps): Alerts {
    const zone: ZoneSettler = createZoneSettler({ settleMs: deps.limits.settleMs, changeFraction: ZONE_CHANGE_FRACTION });
    const log = deps.log ?? (() => undefined);
    /** The zone the settler's picture belongs to; a different zone starts it over. */
    let zoneKey = "";
    /** The frame of the last look at which the zone changed: what a pop-up that is gone by the confirming look is read from. */
    let detection: Frame | null = null;
    let waiting: Appearance | null = null;
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

    /** Run, defer or drop an appearance, in that order of preference. */
    function admit(change: Appearance, now: number): void {
        const settings = deps.settings();
        const skipped = (reason: string, about: Appearance): void =>
            record({ score: about.score, outcome: "skipped", reason, asked: false, rule: settings.rule, latency: latencyOf(about) });
        if (running || now - lastCheckAt < deps.limits.minCheckGapMs) {
            if (waiting) skipped("replaced by a newer pop-up before the minimum gap between checks ended", waiting);
            waiting = change;
            return;
        }
        if (deps.store.askedSince(deps.userId, now - DAY_MS) >= deps.limits.dailyCap) {
            return skipped(`daily cap of ${deps.limits.dailyCap} checks reached`, change);
        }
        start(change, now);
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

            // The chat model, if there is one: the OCR text in (never the picture), a sentence out; with a rule, SKIP for what the rule does
            // not ask about. A call never waits for it. Any failure leaves the rules' own text, and the log says why (a reason, never text).
            let body = toast.body;
            let summary: CheckEntry["summary"];
            if (present()) return held();
            if (toast.kind !== "call" && deps.model.available()) {
                const started = deps.now();
                const answer = await ask(settings.rule, toast.lines);
                latency.summarisedAt = deps.now();
                const ms = latency.summarisedAt - started;
                if (answer.kind === "skip") {
                    return record({ ...common(), summary: { used: false, ms }, outcome: "no", reason: "The rule says this pop-up is not what you asked about." });
                }
                if (answer.kind === "text") {
                    body = answer.text;
                    summary = { used: true, ms };
                } else {
                    summary = { used: false, ms, skipped: `summary skipped: ${answer.why}` };
                }
            }

            if (present()) return held();
            const ttlSec = toast.kind === "call" ? CALL_TTL_SEC : ALERT_TTL_SEC;
            const payload: PushPayload = { title: toast.title, body, tag: toast.tag, url: "/app/", badge: 1 };
            const done = { ...common(), ...(summary ? { summary } : {}) };
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
                        titleChars: toast.title.length,
                        bodyChars: body.length,
                        ...(deps.logText ? { title: toast.title, body } : {}),
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

    /** The model's answer to one pop-up, or why there is none. The timeout is hard: the request is abandoned, not waited for. */
    async function ask(rule: string, lines: readonly string[]): Promise<ReturnType<typeof parseAnswer>> {
        const { system, user } = summaryRequest(lines, rule);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timed out">((resolve) => {
            timer = setTimeout(() => resolve("timed out"), SUMMARY_TIMEOUT_MS);
        });
        try {
            const raw = await Promise.race([deps.model.ask(system, user, SUMMARY_TIMEOUT_MS), timedOut]);
            if (raw === "timed out") return { kind: "unusable", why: "timed out" };
            if (raw === undefined) return { kind: "unusable", why: "no chat model" };
            return parseAnswer(raw, rule !== "");
        } catch {
            return { kind: "unusable", why: "model error" };
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        wakeAt: () => zone.wakeAt,

        look(frame, now) {
            const settings = deps.settings();
            const key = JSON.stringify(settings.alertZone);
            if (key !== zoneKey) {
                zoneKey = key;
                zone.reset();
                waiting = null;
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
            if (waiting && !running && now - lastCheckAt >= deps.limits.minCheckGapMs) {
                const change = waiting;
                waiting = null;
                admit(change, now);
            }
        },

        async idle() {
            while (running) await running;
        },

        status: () => ({ pending: zone.wakeAt !== null, waiting: waiting !== null, checking: running !== null }),
    };
}
