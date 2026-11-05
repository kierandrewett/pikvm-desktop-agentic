import { createHash } from "node:crypto";

/**
 * The words of a notification: what the host builds from the image model's description, for the slow path and the fast one.
 * Nothing here calls a model.
 */

/**
 * A description as a notification's body: its first sentence, and the second as well while the two fit in 160 characters
 * (the prompt leads with what matters, and a lone short sentence such as "Installation failed." says little).
 */
export function notificationBody(description: string): string {
    const sentences = description.split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== "");
    let body = sentences[0] ?? description;
    if (body.length > 160) return `${body.slice(0, 157).trimEnd()}...`;
    const second = sentences[1];
    if (second && body.length + 1 + second.length <= 160) body = `${body} ${second}`;
    return body;
}

/** The model found nothing to read: it answered "No notification." (in any case, with or without the full stop). */
export function isNoNotification(description: string): boolean {
    return /^no notifications?\b/i.test(description.trim());
}

/**
 * Whether a description is of a call that is ringing: "incoming call", "calling", "ringing", or the Accept and Decline
 * buttons a call toast has. A chat message that merely contains "call" (a "call me later") is not.
 */
export function looksLikeCall(description: string): boolean {
    return /\b(?:incoming (?:[a-z]+ ){0,2}call|is calling|are calling|calling you|ringing)\b/i.test(description) || (/\baccept\b/i.test(description) && /\bdecline\b/i.test(description));
}

/** Who is calling, when the description says: "Incoming call from Anna Berg." or "Anna Berg is calling." */
export function callerOf(description: string): string | undefined {
    const stop = String.raw`(?=[.,;:()!?]| with | and | on | via |$)`;
    const from = new RegExp(String.raw`\b(?:incoming (?:[a-z]+ ){0,2}call|call|calling|ringing)\s+(?:from|by)\s+(.+?)${stop}`, "i").exec(description);
    const calling = /\b([A-Z][\p{L}'’.-]*(?: [A-Z][\p{L}'’.-]*){0,3}) is calling\b/u.exec(description);
    const who = (from?.[1] ?? calling?.[1])?.trim().replace(/^["“']|["”']$/g, "");
    return who ? who.slice(0, 60) : undefined;
}

/** The same pop-up text however it is spaced or capitalised: what repeated notifications are told apart by. */
export function descriptionHash(description: string): string {
    const normal = description.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}

export interface AlertNotification {
    title: string;
    body: string;
    tag: string;
    urgency: "normal" | "high";
    isCall: boolean;
}

/**
 * The notification for a fast alert. A call is told apart (title "Incoming call: <who>", `high` urgency, one tag so a call
 * that rings again updates the same notification); anything else is a normal alert with a tag of its own text, so two
 * different messages are two notifications and the same one twice is one.
 */
export function alertNotification(description: string): AlertNotification {
    const body = notificationBody(description);
    if (looksLikeCall(description)) {
        const who = callerOf(description);
        return { title: who ? `Incoming call: ${who}` : "Incoming call", body, tag: "pikvm-call", urgency: "high", isCall: true };
    }
    return { title: "PiKVM", body, tag: `pikvm-alert-${descriptionHash(description).slice(0, 8)}`, urgency: "normal", isCall: false };
}
