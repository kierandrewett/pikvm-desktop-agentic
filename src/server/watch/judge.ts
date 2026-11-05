import { JUDGE_REASONS, type JudgeReason, type ModelFailure } from "@pikvm/contracts/watch";
import { MAX_BODY_CHARS } from "./limits";
import { judgeRequest, JUDGE_MAX_TOKENS, readRequest, READ_MAX_TOKENS } from "./prompts";

/**
 * The chat model's two steps on one pop-up, around the prompts in prompts.ts: what is asked, what comes back and whether it can be
 * trusted. Text in, text out: what the model is and how it is reached is the chat server's business (`smallText`), and nothing here
 * names a provider.
 *
 * A model's answer is untrusted input. It may be fenced in markdown, wrapped in a sentence, cut off, the wrong type or the wrong word,
 * and a small local model does all of these. So every field is checked, every length clamped, control characters stripped, and an answer
 * that does not pass is a named failure (`ModelFailure`), never a half-trusted value. What a failure means is alerts.ts's policy:
 * READ failing hands the judge the OCR lines; JUDGE failing sends the notification anyway.
 */

/** What READ found: the pop-up as facts. Every field is always there; "not shown" is null or empty. */
export interface Facts {
    source: string | null;
    from: string | null;
    subject: string | null;
    /** Every line of the pop-up, repaired, in order. */
    text: string;
    when: string | null;
    numbers_and_codes: string[];
    actions: string[];
    urgent_words: string[];
}

/** What JUDGE decided. `body` is empty when `notify` is false. */
export interface Verdict {
    notify: boolean;
    reason: JudgeReason;
    body: string;
    title: string | null;
}

/** The reasons that mean "interrupt the person" and the ones that mean "do not"; `rule` and `other` fit either. */
const NOTIFY_REASONS: ReadonlySet<JudgeReason> = new Set(["call", "person_waiting", "time_critical", "security", "failure", "money_legal", "real_world"]);
const SKIP_REASONS: ReadonlySet<JudgeReason> = new Set(["routine", "marketing_social", "chatter", "duplicate"]);

const MAX_TEXT_CHARS = 700;
const MAX_FIELD_CHARS = 120;
const MAX_ITEM_CHARS = 60;
const MAX_ITEMS = 12;
const MAX_TITLE_CHARS = 40;

/** The step's answer, or why there is none. `ms` is the time the step took, whichever way it went. */
export type StepResult<T> = { ok: true; value: T; ms: number } | { ok: false; failure: ModelFailure; ms: number };

/** A way to ask the model: the caller's `AlertModel.ask`. The time limit is the request's own (the request is aborted) and this module's (the wait is abandoned). */
export type Ask = (system: string, user: string, options: { timeoutMs: number; maxTokens: number; json: true }) => Promise<string | undefined>;

/** Control characters and format characters (zero-width, bidi) out, whitespace collapsed. */
function clean(text: string): string {
    return text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Emoji and pictographs out: a notification body is plain text. */
function plain(text: string): string {
    return clean(text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu, ""));
}

/** At most `max` characters, cut at a word with "..." when it had to be cut. */
export function clamp(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 3);
    const space = cut.lastIndexOf(" ");
    return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/**
 * The first balanced `{...}` in a model's answer that parses as an object, or undefined. Tolerates a markdown fence, a sentence before or
 * after, and braces inside strings; skips a balanced block that is not JSON and tries the next. Not a general JSON scanner: it only has to
 * find the one object a model was asked for.
 */
export function firstJsonObject(raw: string): Record<string, unknown> | undefined {
    for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < raw.length; i++) {
            const ch = raw[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}" && --depth === 0) {
                try {
                    const value: unknown = JSON.parse(raw.slice(start, i + 1));
                    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
                } catch {
                    /* not JSON: try the next opening brace */
                }
                break;
            }
        }
    }
    return undefined;
}

/** A string field: a string or a number is taken, anything else is "not shown". */
function text(value: unknown, max: number): string | null {
    const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    const out = clamp(clean(raw), max);
    return out === "" ? null : out;
}

/** A list field: a list of strings and numbers, or one string (a weak model's habit), de-duplicated and bounded. */
function list(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const out: string[] = [];
    for (const item of items) {
        const each = text(item, MAX_ITEM_CHARS);
        if (each !== null && !out.includes(each)) out.push(each);
        if (out.length >= MAX_ITEMS) break;
    }
    return out;
}

const FACT_KEYS = ["source", "from", "subject", "text", "when", "numbers_and_codes", "actions", "urgent_words"] as const;

/** READ's answer, validated. "invalid" for something that is not the object asked for; "empty" for an object with nothing in it. */
export function parseFacts(raw: string): { ok: true; value: Facts } | { ok: false; failure: ModelFailure } {
    const object = firstJsonObject(raw);
    if (!object || !FACT_KEYS.some((key) => key in object)) return { ok: false, failure: "invalid" };
    // `text` may come as a list of lines: join it as it would have been.
    const body = Array.isArray(object["text"]) ? object["text"].map((line) => text(line, MAX_TEXT_CHARS)).filter((line) => line !== null).join(" / ") : object["text"];
    const facts: Facts = {
        source: text(object["source"], MAX_FIELD_CHARS),
        from: text(object["from"], MAX_FIELD_CHARS),
        subject: text(object["subject"], MAX_FIELD_CHARS),
        text: text(body, MAX_TEXT_CHARS) ?? "",
        when: text(object["when"], MAX_FIELD_CHARS),
        numbers_and_codes: list(object["numbers_and_codes"]),
        actions: list(object["actions"]),
        urgent_words: list(object["urgent_words"]),
    };
    // A READ with no text of its own has not read the pop-up, whatever else it filled in.
    if (facts.text === "") return { ok: false, failure: "empty" };
    return { ok: true, value: facts };
}

/** The facts as the judge is given them: compact JSON, in the field order of the prompt, with what is not shown left out. */
export function factsForJudge(facts: Facts): string {
    const shown: Record<string, unknown> = {};
    for (const key of FACT_KEYS) {
        const value = facts[key];
        if (value !== null && value.length > 0) shown[key] = value;
    }
    return JSON.stringify(shown);
}

/** What the judge said is a boolean, or the word for one. */
function truth(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const word = value.trim().toLowerCase();
        if (word === "true" || word === "yes") return true;
        if (word === "false" || word === "no") return false;
    }
    return undefined;
}

/**
 * A reason as the model wrote it ("Person Waiting", "person-waiting") as the word of the list. A word that is not in the list ("social")
 * is "other": the decision is still the model's and the reason only labels it, so a made-up label is not worth losing the decision for.
 * Undefined only when there is no word at all.
 */
function reasonOf(value: unknown): JudgeReason | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const word = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return (JUDGE_REASONS as readonly string[]).includes(word) ? (word as JudgeReason) : "other";
}

/**
 * JUDGE's answer, validated. A verdict that contradicts itself (a reason to interrupt on "do not notify", a reason to stay quiet on
 * "notify"), no decision or no reason word, or a notify with no body is "invalid" / "empty": alerts.ts then notifies anyway, because a
 * confused model must not be the reason a pop-up is lost.
 */
export function parseVerdict(raw: string): { ok: true; value: Verdict } | { ok: false; failure: ModelFailure } {
    const object = firstJsonObject(raw);
    if (!object) return { ok: false, failure: "invalid" };
    const notify = truth(object["notify"]);
    const reason = reasonOf(object["reason"]);
    if (notify === undefined || reason === undefined) return { ok: false, failure: "invalid" };
    if (notify ? SKIP_REASONS.has(reason) : NOTIFY_REASONS.has(reason)) return { ok: false, failure: "invalid" };
    if (!notify) return { ok: true, value: { notify, reason, body: "", title: null } };
    const body = clamp(plain(typeof object["body"] === "string" ? object["body"] : ""), MAX_BODY_CHARS);
    if (body === "") return { ok: false, failure: "empty" };
    const title = clamp(plain(typeof object["title"] === "string" ? object["title"] : ""), MAX_TITLE_CHARS);
    return { ok: true, value: { notify, reason, body, title: title === "" ? null : title } };
}

/**
 * One step: ask, wait at most `timeoutMs` (abandoning the request, not waiting for it), parse. Never throws. `now` is the host's clock,
 * so the timings in the log are the ones in the rest of the entry.
 */
async function step<T>(
    ask: Ask,
    request: { system: string; user: string },
    options: { timeoutMs: number; maxTokens: number },
    parse: (raw: string) => { ok: true; value: T } | { ok: false; failure: ModelFailure },
    now: () => number,
): Promise<StepResult<T>> {
    const started = now();
    const elapsed = () => now() - started;
    if (options.timeoutMs <= 0) return { ok: false, failure: "timeout", ms: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), options.timeoutMs);
    });
    try {
        const raw = await Promise.race([ask(request.system, request.user, { ...options, json: true }), late]);
        if (raw === "late") return { ok: false, failure: "timeout", ms: elapsed() };
        if (raw === undefined) return { ok: false, failure: "error", ms: elapsed() };
        if (clean(raw) === "") return { ok: false, failure: "empty", ms: elapsed() };
        const parsed = parse(raw);
        return parsed.ok ? { ok: true, value: parsed.value, ms: elapsed() } : { ok: false, failure: parsed.failure, ms: elapsed() };
    } catch (error) {
        // A request that ran past its own limit rejects too (it was aborted): that is a timeout, not an error.
        const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, failure: aborted ? "timeout" : "error", ms: elapsed() };
    } finally {
        clearTimeout(timer);
    }
}

/** Step 1: the pop-up's lines to facts. */
export function readFacts(ask: Ask, lines: readonly string[], timeoutMs: number, now: () => number): Promise<StepResult<Facts>> {
    return step(ask, readRequest(lines), { timeoutMs, maxTokens: READ_MAX_TOKENS }, parseFacts, now);
}

/** Step 2: the facts (or, without them, the lines as read) and the person's rule to a verdict. */
export function judgePopup(ask: Ask, input: Facts | readonly string[], rule: string, timeoutMs: number, now: () => number): Promise<StepResult<Verdict>> {
    const request = judgeRequest(Array.isArray(input) ? { lines: input } : { facts: factsForJudge(input as Facts) }, rule);
    return step(ask, request, { timeoutMs, maxTokens: JUDGE_MAX_TOKENS }, parseVerdict, now);
}

/**
 * The body of a notification the judge did not write (it failed twice, never answered or answered nonsense): the facts' text when READ got
 * that far, which has the pop-up's every line with the OCR's run-together words repaired, else the rules' own plain body.
 */
export function failOpenBody(facts: Facts | undefined, plainBody: string): string {
    const text = facts === undefined ? "" : clamp(facts.text, MAX_BODY_CHARS);
    return text === "" ? plainBody : text;
}
