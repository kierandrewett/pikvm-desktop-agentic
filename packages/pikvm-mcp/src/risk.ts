import { parseChord } from "@pikvm/kvm-engine/agent";
import type { ApprovalMode } from "./types";

/**
 * Which calls ask the person first.
 *
 * Approval is decided here, on the arguments, because the agent's own per-tool gate cannot see
 * them: "allow `key`" says nothing about whether the key is `a` or `ctrl+alt+Delete`.
 *
 * Under `risky`, fresh plain clicks, moves and short single-line text do not ask.
 * Smart mode adds screen review in the handler without clearing any rule defined here.
 */

/** Typing more than this, or anything with a line break, asks. A line break can submit a form or run a command. */
export const MAX_PLAIN_TYPE_CHARS = 200;

/** Input without a screenshot younger than this asks: the agent may be acting on a screen that has moved on. */
export const MAX_LOOK_AGE_MS = 30_000;

/** Chords that end or hijack the person's session. Matched on the canonical spelling, left and right folded. */
const RISKY_CHORDS: ReadonlySet<string> = new Set([
    "meta",
    "ctrl+alt+delete",
    "alt+f4",
    "ctrl+w",
    "ctrl+shift+delete",
    ...Array.from({ length: 12 }, (_, i) => `ctrl+alt+f${i + 1}`),
]);

export type RiskLevel = "observe" | "input" | "risky" | "always";

export interface Risk {
    readonly level: RiskLevel;
    /** One phrase per rule that matched. */
    readonly reasons: readonly string[];
    /**
     * The reasons that are hard stops. Smart review can add approval reasons but cannot clear any fixed risk.
     */
    readonly hard?: readonly string[];
}

export interface RiskContext {
    /** Milliseconds since the conversation's last full screenshot; null if never. */
    readonly lookAgeMs: number | null;
}

const OBSERVE: Risk = { level: "observe", reasons: [] };

const INPUT_TOOLS: ReadonlySet<string> = new Set(["mouse_move", "click", "scroll", "type_text", "key", "drag", "power"]);

/** What cannot change anything, so no gate looks at it: the pointer moving and the page scrolling. */
export const FREE_TOOLS: ReadonlySet<string> = new Set(["mouse_move", "scroll"]);

/**
 * Typed text that is a destructive command wherever it ends up: asked about whatever the screen shows, since a model that is wrong
 * about the screen must not be what stands between this text and a shell. A few well-known shapes, not a parser.
 */
const DESTRUCTIVE_TEXT: readonly RegExp[] = [
    /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/i,
    /\bmkfs(\.\w+)?\b/i,
    /\bdd\s+[^\n]*\bof=\/dev\//i,
    /:\(\)\s*\{\s*:\|:&\s*\};:/,
    /\bformat\s+[a-z]:/i,
    /\b(del|erase|rd|rmdir)\s+[^\n]*\/[sq]\b/i,
    /\bRemove-Item\b[^\n]*-Recurse/i,
    /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
    /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    /\bTRUNCATE\s+TABLE\b/i,
    /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\b(shutdown|poweroff|reboot|halt)\b/i,
    /\bchmod\s+-R\s+0?777\b/,
];

export function assess(tool: string, args: Readonly<Record<string, unknown>>, context: RiskContext): Risk {
    if (!INPUT_TOOLS.has(tool)) return OBSERVE;
    const reasons: string[] = [];
    const hard: string[] = [];
    let level: RiskLevel = "input";

    if (tool === "power") {
        // A power change can lose the person's unsaved work, so it asks under every policy.
        const why = `it ${powerWords(args["action"])} the target`;
        return { level: "always", reasons: [why], hard: [why] };
    }
    if (tool === "drag") reasons.push("a drag can move or overwrite things");
    if (tool === "type_text") {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        if (/[\r\n]/.test(text)) reasons.push("the text contains a line break, which can submit or execute");
        if (text.length > MAX_PLAIN_TYPE_CHARS) reasons.push(`the text is longer than ${MAX_PLAIN_TYPE_CHARS} characters`);
        if (DESTRUCTIVE_TEXT.some((pattern) => pattern.test(text))) hard.push("the text is a command that can destroy data or switch the machine off");
    }
    if (tool === "key") {
        const keys = Array.isArray(args["keys"]) ? (args["keys"] as unknown[]) : [];
        for (const text of keys) {
            if (typeof text !== "string") continue;
            const canonical = readCanonical(text);
            if (canonical === null) hard.push(`${text} is not a key chord I can read`);
            else if (RISKY_CHORDS.has(canonical)) hard.push(`${text} can close, switch or lock the person's session`);
        }
    }
    if (context.lookAgeMs === null || context.lookAgeMs > MAX_LOOK_AGE_MS) {
        reasons.push("there has been no screenshot in the last 30 seconds");
    }
    reasons.unshift(...hard);
    if (reasons.length) level = "risky";
    return hard.length ? { level, reasons, hard } : { level, reasons };
}

/** Whether a call with this risk asks under the policy. */
export function needsApproval(risk: Risk, mode: ApprovalMode): boolean {
    if (risk.level === "always") return true;
    if (risk.level === "observe") return false;
    if (mode === "never") return false;
    if (mode === "always") return true;
    return risk.level === "risky";
}

function powerWords(action: unknown): string {
    if (action === "on") return "switches on";
    if (action === "off") return "switches off";
    return "resets";
}

function readCanonical(text: string): string | null {
    try {
        return parseChord(text).canonical;
    } catch {
        return null;
    }
}

/** The question and the plain-words summary the person reads before answering. */
export function describeCall(tool: string, args: Readonly<Record<string, unknown>>): { title: string; summary: string } {
    const at = (p: unknown): string => {
        const point = typeof p === "object" && p !== null ? p : args;
        return `(${String("x" in point ? point.x : "?")}, ${String("y" in point ? point.y : "?")})`;
    };
    switch (tool) {
        case "key": {
            const keys = (Array.isArray(args["keys"]) ? args["keys"] : []).map(String).join(", ");
            return { title: `Press ${keys} on the PiKVM?`, summary: `Press the key chord ${keys}.` };
        }
        case "drag":
            return {
                title: "Drag on the PiKVM screen?",
                summary: `Press the ${String(args["button"] ?? "left")} button at ${at(args["from"])} and release it at ${at(args["to"])}.`,
            };
        case "type_text": {
            const text = String(args["text"] ?? "");
            const shown = text.length > 300 ? `${text.slice(0, 300)}... (${text.length} characters)` : text;
            return { title: "Type this on the PiKVM?", summary: `Type: ${JSON.stringify(shown)}` };
        }
        case "power":
            return {
                title: `Power ${String(args["action"])} the target?`,
                summary: `Send an ATX power action: ${String(args["action"])}.`,
            };
        case "click":
            return { title: "Click on the PiKVM screen?", summary: `Click at ${at(undefined)}.` };
        default:
            return { title: `Allow ${tool} on the PiKVM?`, summary: `${tool} ${JSON.stringify(args)}` };
    }
}
