import { createHash } from "node:crypto";

/**
 * The words of a fast alert, made from what the local OCR read off a pop-up in the corner of the screen. Deterministic: no
 * model; this file sends nothing anywhere. `readToast` classifies the lines (a call, a Teams message, an email, anything else), strips the
 * toast's own furniture (Dismiss, Reply, a close glyph, a clock time) and builds the notification's title, body, tag and urgency.
 *
 * What it does not do is understand the screen: it knows the three kinds of pop-up the feature is for, and shows any other pop-up
 * as the lines it has. A pop-up with too little readable text is "none": no notification, and the log says how much was read.
 */

export type ToastKind = "call" | "teams" | "email" | "other";

export interface Toast {
    kind: ToastKind;
    /** The lines left after the furniture was stripped. */
    lines: string[];
    /** The app the pop-up names, when it does ("Teams", "Outlook"). */
    app?: string;
    /** Who the call or message is from. */
    who?: string;
    title: string;
    /** At most `MAX_BODY_CHARS`. */
    body: string;
    tag: string;
    urgency: "normal" | "high";
    /** The words of `lines`: what the minimum counts. */
    words: number;
}

export const MAX_BODY_CHARS = 160;
const MAX_TITLE_CHARS = 60;

/** Fewer words than this is not a pop-up's text: a glyph, an icon's name, OCR noise. */
export const MIN_TOAST_WORDS = 3;

/** Lines that are a toast's buttons and controls, not its message. Matched whole, case-insensitively. */
const FURNITURE = /^(?:dismiss|reply|close|snooze|mark as read|mark read|open|view|see more|more|now|just now|today|settings|clear|options|ok|cancel|x|[×✕✖]|\.{2,}|…)$/i;
/** A clock time ("10:42", "10:42 AM") or a date ("11/05/2026"): the taskbar's, caught in the crop. */
const CLOCK = /^(?:\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})$/i;
const ACCEPT = /\b(?:accept|answer)\b/i;
const DECLINE = /\b(?:decline|reject|ignore)\b/i;
const CALLING = /\b(?:incoming (?:[a-z]+ ){0,2}call|is calling|calling you|are calling|ringing|wants to call)\b/i;
const TEAMS = /\b(?:microsoft teams|teams|mentioned you|replied to|sent a message|sent you a message)\b/i;
const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const EMAIL = /\b(?:outlook|new mail|new email|mail)\b|\bfrom:|\bsubject:/i;
/** Two to four capitalised words: a person's name as a toast shows it. */
const NAME = /^\p{Lu}[\p{L}'’.-]*(?:\s\p{Lu}[\p{L}'’.-]*){0,3}$/u;

const wordsOf = (text: string): number => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/** The lines of an OCR result, trimmed, without the furniture, empty lines and lines with nothing readable in them. */
export function cleanLines(raw: readonly string[]): string[] {
    const out: string[] = [];
    for (const line of raw) {
        const text = line.replace(/\s+/g, " ").trim();
        if (text === "" || FURNITURE.test(text) || CLOCK.test(text)) continue;
        // A line of symbols or of a single stray letter is not text.
        if (!/[\p{L}\p{N}]{2}/u.test(text)) continue;
        out.push(text);
    }
    return out;
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text);

/** The same text however it is spaced, capitalised or punctuated: what repeated notifications are told apart by. */
export function toastHash(text: string): string {
    const normal = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}

function callerOf(lines: readonly string[]): string | undefined {
    for (const line of lines) {
        const before = /^(.+?)\s+(?:is calling(?: you)?|are calling|calling you|wants to call(?: you)?)\b/i.exec(line)?.[1];
        if (before) return before.replace(/^["“']|["”']$/g, "").slice(0, MAX_TITLE_CHARS);
        const from = /\bincoming (?:[a-z]+ ){0,2}call (?:from|by)\s+(.+?)(?=[.,;:()!?]|\s(?:with|on|via)\s|$)/i.exec(line)?.[1];
        if (from) return from.slice(0, MAX_TITLE_CHARS);
    }
    // No "is calling" line: the first line that looks like a name, not the app or a button.
    return lines.find((line) => NAME.test(line) && !TEAMS.test(line) && !ACCEPT.test(line) && !DECLINE.test(line))?.slice(0, MAX_TITLE_CHARS);
}

/**
 * Classify what a toast says and build its notification, or null when there is too little to say anything. `raw` are the OCR
 * lines in reading order.
 */
export function readToast(raw: readonly string[]): Toast | null {
    const lines = cleanLines(raw);
    const words = lines.reduce((sum, line) => sum + wordsOf(line), 0);
    if (words < MIN_TOAST_WORDS) return null;
    const all = lines.join("\n");

    if (CALLING.test(all) || (ACCEPT.test(all) && DECLINE.test(all))) {
        const who = callerOf(lines);
        const message = lines.filter((line) => !ACCEPT.test(line) && !DECLINE.test(line) && !TEAMS.test(line) && line !== who && !CALLING.test(line));
        return {
            kind: "call",
            lines,
            ...(TEAMS.test(all) ? { app: "Teams" } : {}),
            ...(who ? { who } : {}),
            title: who ? `Incoming call: ${who}` : "Incoming call",
            body: shorten(message.length > 0 ? message.join(" - ") : lines.filter((line) => !ACCEPT.test(line) && !DECLINE.test(line)).join(" - ") || "Incoming call", MAX_BODY_CHARS),
            // One tag per caller: the same person ringing again replaces the notification, a second person does not.
            tag: `pikvm-call-${toastHash(who ?? "unknown").slice(0, 8)}`,
            urgency: "high",
            words,
        };
    }

    const app = TEAMS.test(all) ? "Teams" : EMAIL.test(all) || EMAIL_ADDRESS.test(all) ? "Outlook" : undefined;
    const appLine = lines.findIndex((line) => (app === "Teams" ? /\bteams\b/i : app === "Outlook" ? /\b(?:outlook|mail)\b/i : /$^/).test(line) && wordsOf(line) <= 3);
    // The lines that are the message itself: everything but the app's own line.
    const content = lines.filter((_, i) => i !== appLine);
    const first = lines[0] ?? "";
    const who = app && content[0] && content[0].length <= MAX_TITLE_CHARS && (NAME.test(content[0]) || content.length > 1) ? content[0] : undefined;
    const rest = who ? content.slice(1) : content;

    let title: string;
    let body: string;
    if (app) {
        title = app;
        body = who ? `${who}: ${rest.join(" - ")}` : content.join(" - ");
    } else {
        // Any other pop-up: its first line is its heading (usually the app or the event), the rest is what it says.
        title = shorten(first, MAX_TITLE_CHARS);
        body = lines.length > 1 ? lines.slice(1).join(" - ") : first;
    }
    body = shorten(body.replace(/:\s*$/, "").trim() || title, MAX_BODY_CHARS);
    return {
        kind: app === "Teams" ? "teams" : app === "Outlook" ? "email" : "other",
        lines,
        ...(app ? { app } : {}),
        ...(who ? { who } : {}),
        title,
        body,
        tag: `pikvm-alert-${toastHash(`${title} ${body}`).slice(0, 8)}`,
        urgency: "normal",
        words,
    };
}

/** The text a user's rule is judged against: the app and the lines, as one line. */
export function toastForRule(toast: Toast): string {
    return `${toast.app ?? toast.title}: ${toast.lines.join(" | ")}`.slice(0, 600);
}
