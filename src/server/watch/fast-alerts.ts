import type { CheckEntry, CheckLatency, WatchSettings } from "@pikvm/contracts/watch";
import { alertNotification, descriptionHash, isNoNotification } from "./alert-text";
import { changedBox, createZoneSettler, zoneCells, type ZoneCells, type ZoneSettler } from "./frame-diff";
import {
    FAST_ALERT_TTL_SEC,
    FAST_CALL_TTL_SEC,
    FAST_DUPLICATE_MS,
    OCR_PAD_CELLS,
    OCR_TIMEOUT_MS,
    VISION_FALLBACK_SCORE,
    ZONE_CHANGE_FRACTION,
    ZONE_MAX_FRACTION,
    type FastLimits,
} from "./limits";
import { ModelError, type ModelClient, type ModelProvider } from "./models";
import { OcrTimeoutError, type Ocr, type OcrResult } from "./ocr";
import type { Frame } from "./pipeline";
import { PushError, type Push, type PushPayload } from "./push";
import type { WatchStore } from "./store";
import { cleanLines, MIN_TOAST_WORDS, readToast, toastForRule, toastHash, type ToastKind } from "./toast-rules";

/**
 * FAST ALERTS: one user's second path, for a pop-up in one corner of the screen (an email, a Teams message, a Teams call).
 * docs/deploy-web.md ("Fast alerts") has the flow and the numbers.
 *
 * Zone diff, then a crop, then OCR on this host, then text rules, then the push. No model is involved and nothing leaves the host,
 * except in the two cases below that need a user's key and that the log names. It differs from the slow path (pipeline.ts) in
 * what it is for, and so in each rule:
 *  - it watches one rectangle (the zone) of the same grey grid, not the whole screen;
 *  - a change counts as an APPEARANCE once it has held `fast.settleMs` (1.2 s, not 6 s), and is not dropped if it goes away
 *    afterwards: it is read from the look that saw it ("detected") when it has gone again by the confirming look, and from the
 *    confirming look otherwise;
 *  - only the cells that changed (the pop-up and a margin) are cropped and read;
 *  - it has its own gap and daily cap, so it never eats the slow path's budget, and two toasts 5 s apart both notify;
 *  - with no rule there is nothing to decide, so no Jev call and no network call at all: the notification follows the text;
 *    with a rule, Jev is asked about the text, exactly as the slow path asks it;
 *  - the same pop-up text inside `FAST_DUPLICATE_MS` is told once.
 * The two cases that ask a vision model (OpenRouter, the user's key) instead: the OCR timed out or failed, or it read fewer than
 * `MIN_TOAST_WORDS` words in a change big enough to be a dialog. Without a key they log and send nothing.
 * Every check logs the timestamps of its path (frame captured, seen, held, read, decided, pushed) and never the screen's words
 * (unless the host runs with `PIKVM_WATCH_LOG_TEXT=1`).
 */

/** Jev's "previous" for an alert: there was no pop-up. The slow path says the same for a screen it has no description of. */
export const ALERT_PREVIOUS = "(none)";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FastAlertDeps {
    userId: string;
    store: WatchStore;
    push: Push;
    models: ModelClient;
    /** The user's OpenRouter provider right now; undefined when there is no key. Only the fallback and a user's rule need it. */
    provider(): ModelProvider | undefined;
    settings(): WatchSettings;
    limits: FastLimits;
    now(): number;
    ocr: Ocr;
    /** The crop of a frame to a rectangle of grid cells, as a JPEG that is scaled down only if its long edge passes the model's. Throws when it cannot be cut. */
    crop(jpeg: Buffer, cells: ZoneCells): Promise<Buffer>;
    /** Put the pop-up's words in the check log. Off unless the operator asks (`PIKVM_WATCH_LOG_TEXT=1`). */
    logText?: boolean;
    log?(line: string): void;
}

export interface FastAlerts {
    /** Fast alerts are switched on in the user's settings. */
    readonly on: boolean;
    /** The zone's cells while on: the slow path blanks them so a pop-up is not also a whole-screen change. */
    maskCells(): ZoneCells | null;
    /** One look. Never waits for OCR or a model. */
    look(frame: Frame, now: number): void;
    /** When a pending change will have held long enough: the moment worth an extra look. */
    readonly wakeAt: number | null;
    idle(): Promise<void>;
    status(): { alertPending: boolean; alertWaiting: boolean; alerting: boolean };
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

/** What is sent, however it was read. */
interface Built {
    kind: ToastKind;
    title: string;
    body: string;
    tag: string;
    urgency: "normal" | "high";
    /** The text a user's rule is judged against. */
    forRule: string;
    hash: string;
}

/**
 * The lines of an OCR result that lie inside the pop-up (the cells that changed), when the engine says where each line was. A pop-up
 * over a page of text has the page's text in the margin around it. If nothing is inside (the pop-up's text sits where the diff did
 * not see it change) all lines are kept rather than none.
 */
function onlyPopup(ocr: OcrResult, change: Appearance): string[] {
    const { region, core } = change;
    if (!ocr.boxes || ocr.boxes.length !== ocr.lines.length) return ocr.lines;
    const width = region.x1 - region.x0;
    const height = region.y1 - region.y0;
    // A little slack: a line's box is the OCR's, a pixel or two either side of the text.
    const slack = 0.02;
    const inside = ocr.lines.filter((_, i) => {
        const box = ocr.boxes![i]!;
        const x = ((((box.x0 + box.x1) / 2) * width + region.x0 - core.x0) / (core.x1 - core.x0));
        const y = ((((box.y0 + box.y1) / 2) * height + region.y0 - core.y0) / (core.y1 - core.y0));
        return x >= -slack && x <= 1 + slack && y >= -slack && y <= 1 + slack;
    });
    return inside.length > 0 ? inside : ocr.lines;
}

const wordCount = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length, 0);

export function createFastAlerts(deps: FastAlertDeps): FastAlerts {
    const zone: ZoneSettler = createZoneSettler({ settleMs: deps.limits.settleMs, changeFraction: ZONE_CHANGE_FRACTION });
    const log = deps.log ?? (() => undefined);
    /** The zone the settler's quiet picture belongs to; a different zone (or fast alerts off and on) starts it over. */
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
            .catch((error: unknown) => log(`[watch] fast check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
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
            if (waiting) skipped("replaced by a newer pop-up before the minimum gap between fast checks ended", waiting);
            waiting = change;
            return;
        }
        if (deps.store.askedSince(deps.userId, now - DAY_MS, "alert") >= deps.limits.dailyCap) {
            return skipped(`daily cap of ${deps.limits.dailyCap} fast checks reached`, change);
        }
        start(change, now);
    }

    async function check(change: Appearance): Promise<void> {
        const settings = deps.settings();
        const latency = latencyOf(change);
        const base = { score: change.score, rule: settings.rule, latency } as const;
        let asked = false;
        let costUsd = 0;
        let read: CheckEntry["read"];
        let text: string[] = [];
        try {
            const crop = await deps.crop(change.frame.jpeg, change.region);
            asked = true;

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
            const words = ocr ? wordCount(cleanLines(lines)) : 0;
            if (ocr) {
                read = { by: "ocr", ms: ocr.ms, chars: lines.join("\n").length, words, lines: lines.length };
                text = lines;
            }
            const common = () => ({
                ...base,
                asked,
                ...(read ? { read } : {}),
                ...(deps.logText && text.length > 0 ? { description: text.join("\n") } : {}),
                ...(costUsd > 0 ? { costUsd } : {}),
            });

            let built: Built;
            const doubtful = !toast && change.score >= VISION_FALLBACK_SCORE;
            if (ocrFailure !== undefined || doubtful) {
                const why = ocrFailure ?? `the OCR read ${words} words (fewer than ${MIN_TOAST_WORDS}) in a change big enough to be a dialog`;
                const provider = deps.provider();
                if (!provider) {
                    return record({ ...common(), outcome: ocrFailure !== undefined ? "error" : "skipped", reason: `${why}, and there is no OpenRouter key for the vision model, so nothing was sent` });
                }
                const described = await deps.models.describeAlert(provider, settings.visionModel, crop);
                costUsd += described.costUsd ?? 0;
                latency.readAt = deps.now();
                text = [described.text];
                read = { by: "vision", ms: latency.readAt - latency.detectedAt, chars: described.text.length, words: wordCount(text), lines: 1, fallback: why };
                if (isNoNotification(described.text)) {
                    return record({ ...common(), model: settings.visionModel, outcome: "no", reason: "The corner showed no notification, so nothing was sent." });
                }
                const alert = alertNotification(described.text);
                built = {
                    kind: alert.isCall ? "call" : "other",
                    title: alert.title,
                    body: alert.body,
                    tag: alert.tag,
                    urgency: alert.urgency,
                    forRule: described.text,
                    hash: descriptionHash(described.text),
                };
            } else if (!toast) {
                return record({ ...common(), outcome: "skipped", reason: `The corner had no readable text (${words} words read), so nothing was sent.` });
            } else {
                built = {
                    kind: toast.kind,
                    title: toast.title,
                    body: toast.body,
                    tag: toast.tag,
                    urgency: toast.urgency,
                    forRule: toastForRule(toast),
                    hash: toastHash(`${toast.title} ${toast.body}`),
                };
            }
            const used = read?.by === "vision" ? { model: settings.visionModel } : {};

            const before = notified.get(built.hash);
            if (before !== undefined && deps.now() - before < FAST_DUPLICATE_MS) {
                const seconds = Math.round((deps.now() - before) / 1000);
                return record({ ...common(), ...used, outcome: "skipped", reason: `The same pop-up text was notified ${seconds} seconds ago, so it was not sent again.` });
            }

            let noul: number | undefined;
            let fromCache = false;
            if (settings.rule.trim() !== "") {
                const provider = deps.provider();
                if (!provider) {
                    return record({ ...common(), ...used, outcome: "error", reason: "Your rule needs the OpenRouter key (Settings, Providers) and there is none, so nothing was sent." });
                }
                const decision = await deps.models.decide(provider, { previous: ALERT_PREVIOUS, current: built.forRule, rule: settings.rule });
                costUsd += decision.costUsd ?? 0;
                noul = decision.noul;
                fromCache = decision.cached;
                latency.decidedAt = deps.now();
                const decided = { ...common(), ...used, noul, ...(fromCache ? { fromCache: true } : {}) };
                if (decision.verdict === "no") return record({ ...decided, outcome: "no" });
                if (decision.verdict === "undecided") return record({ ...decided, outcome: "undecided", reason: "Jev's answer was not decisive, so nothing was sent" });
            } else {
                // No rule: nothing to decide, and nothing to ask a model.
                latency.decidedAt = latency.readAt;
            }

            const ttlSec = built.kind === "call" ? FAST_CALL_TTL_SEC : FAST_ALERT_TTL_SEC;
            const payload: PushPayload = { title: built.title, body: built.body, tag: built.tag, url: "/app/", badge: 1 };
            const sentFacts = {
                kind: built.kind,
                tag: built.tag,
                urgency: built.urgency,
                ttlSec,
                titleChars: built.title.length,
                bodyChars: built.body.length,
                ...(deps.logText ? { title: built.title, body: built.body } : {}),
            };
            const done = { ...common(), ...used, ...(noul !== undefined ? { noul } : {}), ...(fromCache ? { fromCache: true } : {}) };
            try {
                const sent = await deps.push.send(deps.userId, payload, { urgency: built.urgency, ttlSeconds: ttlSec });
                latency.pushedAt = deps.now();
                latency.totalMs = latency.pushedAt - latency.capturedAt;
                latency.sinceFirstSeenMs = latency.pushedAt - latency.firstSeenAt;
                const push = { sent: sent.sent, removed: sent.removed, failed: sent.failed.length };
                if (sent.sent > 0) {
                    notified.set(built.hash, latency.pushedAt);
                    for (const [key, at] of notified) if (latency.pushedAt - at >= FAST_DUPLICATE_MS) notified.delete(key);
                    return record({ ...done, outcome: "pushed", push, notified: sentFacts });
                }
                const why = sent.failed[0]?.message ?? "every subscription had expired";
                return record({ ...done, outcome: "error", reason: `The pop-up was read but no notification was delivered: ${why}`, push });
            } catch (error) {
                const reason = error instanceof PushError ? error.message : error instanceof Error ? error.message : "the push failed";
                return record({ ...done, outcome: "error", reason: `The pop-up was read but no notification was delivered: ${reason}` });
            }
        } catch (error) {
            const reason = error instanceof ModelError || error instanceof Error ? error.message : "the check failed";
            record({ ...base, outcome: "error", reason, asked, ...(read ? { read } : {}), ...(costUsd > 0 ? { costUsd } : {}) });
        }
    }

    return {
        get on() {
            return deps.settings().fastAlerts;
        },

        maskCells() {
            const settings = deps.settings();
            return settings.fastAlerts ? zoneCells(settings.alertZone) : null;
        },

        get wakeAt() {
            return zone.wakeAt;
        },

        look(frame, now) {
            const settings = deps.settings();
            const key = settings.fastAlerts ? JSON.stringify(settings.alertZone) : "";
            if (key !== zoneKey) {
                zoneKey = key;
                zone.reset();
                waiting = null;
                detection = null;
            }
            if (!settings.fastAlerts) return;
            const cells = zoneCells(settings.alertZone);
            const seen = zone.look(frame.grid, cells, now);
            if (seen.state === "changing") detection = frame;
            if (seen.state === "appeared" && seen.score > ZONE_MAX_FRACTION) {
                detection = null;
                const big = Math.round(seen.score * 100);
                record({ score: seen.score, outcome: "skipped", reason: `${big}% of the corner changed: that is a window or the whole screen changing, not a pop-up, so it was not read.`, asked: false, rule: settings.rule, latency: { firstSeenAt: seen.firstSeenAt, capturedAt: frame.capturedAt ?? now, detectedAt: now } });
            } else if (seen.state === "appeared") {
                // Read the look that confirmed it, or the look that saw it when it is gone again by now.
                const source = seen.source === "confirmed" ? frame : (detection ?? frame);
                detection = null;
                admit({ score: seen.score, frame: source, region: changedBox(seen.quiet, seen.grid, cells, OCR_PAD_CELLS), core: changedBox(seen.quiet, seen.grid, cells, 0), firstSeenAt: seen.firstSeenAt, detectedAt: now }, now);
            } else if (seen.state !== "changing") {
                detection = null;
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

        status: () => ({ alertPending: zone.wakeAt !== null, alertWaiting: waiting !== null, alerting: running !== null }),
    };
}
