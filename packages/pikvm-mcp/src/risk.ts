import { parseChord } from "@pikvm/kvm-engine/agent";
import type { ApprovalMode } from "./types";

/**
 * Which calls ask the person first.
 *
 * Approval is decided here, on the arguments, because the agent's own per-tool gate cannot see
 * them: "allow `key`" says nothing about whether the key is `a` or `ctrl+alt+Delete`.
 *
 * The risky set is a starting point to be tuned from use. Plain clicks, moves and short single-line
 * text never ask: a person who must approve every click has stopped supervising the agent and is
 * only pressing a button.
 */

/** Typing more than this, or anything with a line break, asks. A line break submits a form or runs a command. */
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
}

export interface RiskContext {
    /** Milliseconds since the conversation's last full screenshot; null if never. */
    readonly lookAgeMs: number | null;
}

const OBSERVE: Risk = { level: "observe", reasons: [] };

const INPUT_TOOLS: ReadonlySet<string> = new Set(["mouse_move", "click", "scroll", "type_text", "key", "drag", "power"]);

export function assess(tool: string, args: Readonly<Record<string, unknown>>, context: RiskContext): Risk {
    if (!INPUT_TOOLS.has(tool)) return OBSERVE;
    const reasons: string[] = [];
    let level: RiskLevel = "input";

    if (tool === "power") {
        // A power change can lose the person's unsaved work, so it asks under every policy.
        return { level: "always", reasons: [`it ${powerWords(args["action"])} the target`] };
    }
    if (tool === "drag") reasons.push("a drag can move or overwrite things");
    if (tool === "type_text") {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        if (/[\r\n]/.test(text)) reasons.push("the text contains a line break, which submits");
        if (text.length > MAX_PLAIN_TYPE_CHARS) reasons.push(`the text is longer than ${MAX_PLAIN_TYPE_CHARS} characters`);
    }
    if (tool === "key") {
        const keys = Array.isArray(args["keys"]) ? (args["keys"] as unknown[]) : [];
        for (const text of keys) {
            if (typeof text !== "string") continue;
            const canonical = readCanonical(text);
            if (canonical === null) reasons.push(`${text} is not a key chord I can read`);
            else if (RISKY_CHORDS.has(canonical)) reasons.push(`${text} can close, switch or lock the person's session`);
        }
    }
    if (context.lookAgeMs === null || context.lookAgeMs > MAX_LOOK_AGE_MS) {
        reasons.push("there has been no screenshot in the last 30 seconds");
    }
    if (reasons.length) level = "risky";
    return { level, reasons };
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
