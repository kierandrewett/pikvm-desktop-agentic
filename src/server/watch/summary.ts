import { SUMMARY_MAX_CHARS } from "./limits";

/**
 * The one request the watch makes to the user's chat model: the text read off a pop-up in, one sentence out for the notification, or,
 * when the user has a rule, the exact word SKIP for a pop-up that is not what the rule asks about. Text only: the picture never goes.
 * What the model is, and how it is reached, is the chat server's business (`smallText`): nothing here names a provider.
 */

export const SKIP_WORD = "SKIP";

export const SUMMARY_PROMPT =
    "You turn the text read off a notification pop-up on a screen into one short sentence for a phone notification. Say who it is " +
    "from, what it is about and what is asked, using only what the text says. Fix words the reader ran together or misread when the " +
    "text makes the right word clear. Never add anything the text does not say, and never guess a name. Reply with that one sentence " +
    `only: plain text, at most ${SUMMARY_MAX_CHARS} characters, no quotes, no preamble. Example: the text "Ana Silva | Lunch Thursday? | ` +
    'Are you free at 12:30 for thereview" becomes: Ana Silva asks if you are free Thursday at 12:30 for the review';

/** Added when the user has a rule. The rule itself goes in the user message, never in the instructions. */
export const RULE_ADDENDUM =
    ` The user only wants to hear about pop-ups that match the rule given after the text. If this pop-up does not match it, reply with exactly ${SKIP_WORD} and nothing else.`;

/** The instructions and the message for one request. */
export function summaryRequest(lines: readonly string[], rule: string): { system: string; user: string } {
    const text = lines.join(" | ");
    return rule === "" ? { system: SUMMARY_PROMPT, user: text } : { system: SUMMARY_PROMPT + RULE_ADDENDUM, user: `Text: ${text}\nRule: ${rule}` };
}

export type Answer =
    | { kind: "skip" }
    | { kind: "text"; text: string }
    /** Not usable: the reason, never the text. */
    | { kind: "unusable"; why: string };

/** What the model said, as one of: skip this pop-up (only with a rule), a sentence for the body, or unusable (empty, too long). */
export function parseAnswer(raw: string, hasRule: boolean): Answer {
    const text = raw.replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (text === "") return { kind: "unusable", why: "empty" };
    if (/^skip\.?$/i.test(text)) return hasRule ? { kind: "skip" } : { kind: "unusable", why: "unexpected answer" };
    if (text.length > SUMMARY_MAX_CHARS) return { kind: "unusable", why: `too long (${text.length} characters)` };
    return { kind: "text", text };
}
