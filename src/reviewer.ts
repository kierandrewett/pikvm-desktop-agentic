/**
 * Operation reviewer.
 *
 * A single authorization chokepoint that *every* operation passes through —
 * both the embedded Pi runner (via `beforeToolCall`) and the integrated MCP
 * server consult it before any HID action actuates the target.
 *
 * Policy is live-switchable:
 *  - "risky-only"      (default): navigation auto-runs; risky ops prompt.
 *  - "review-all"               : every op is held for explicit authorization.
 *  - "autorun-trusted"          : only the hard deny-list ever prompts.
 *
 * The authorization prompt is three-way: Allow / Deny / "Do something
 * different" (a free-text redirect that steers the agent onto a new course).
 */

import { EventEmitter } from "events";

export type ReviewPolicy = "risky-only" | "review-all" | "autorun-trusted";
export type Decision = "allow" | "deny" | "redirect";

export interface Operation {
    /** Tool name, e.g. "type_text", "click", "press_key". */
    tool: string;
    args: Record<string, unknown>;
    /** Where the op originated. */
    source: "agent" | "mcp";
    /** Optional human label for the timeline. */
    label?: string;
    /**
     * Set when this input action lands in a SENSITIVE part of an app (a chat
     * compose box, a Send button, a terminal, ...): forces an approval prompt so
     * the agent can't blindly click/type somewhere an accident has consequences.
     */
    sensitive?: { reason: string; app?: string };
}

export interface Verdict {
    decision: Decision;
    /** For "redirect": the user's alternative instruction. */
    text?: string;
    /** For "deny": why (surfaced to the agent so it can adapt). */
    reason?: string;
    /** Remember this op kind for the session (auto-allow next time). */
    rememberKind?: boolean;
}

export interface AuthRequest {
    id: string;
    op: Operation;
    risky: boolean;
    reason?: string;
    /** A coarse "kind" used for the always-allow set. */
    kind: string;
}

/** The UI bridge registers this to surface a prompt and await the user. */
export type Prompter = (req: AuthRequest) => Promise<Verdict>;

export interface LogEntry {
    id: string;
    op: Operation;
    risky: boolean;
    reason?: string;
    decision: Decision | "auto-allow";
    redirectText?: string;
    at: number;
}

const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
    { re: /\brm\s+-[rf]{1,2}\b/i, reason: "recursive/force file deletion" },
    { re: /\b(shutdown|reboot|poweroff|halt|init\s+0)\b/i, reason: "power/reboot command" },
    { re: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format" },
    { re: /\bdd\s+if=/i, reason: "raw disk write (dd)" },
    { re: /\b(format)\s+[a-z]:/i, reason: "drive format" },
    { re: /\bdrop\s+(table|database)\b/i, reason: "destructive SQL" },
    { re: /\bsudo\b/i, reason: "privileged command (sudo)" },
    { re: /\bgit\s+push\s+.*--force\b/i, reason: "force push" },
    { re: /:\(\)\s*\{.*\};:/, reason: "fork bomb" },
    { re: /\b(curl|wget)\b.+\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "pipe-to-shell" },
];

/** Keys that submit/commit and are worth flagging when paired with risky text. */
const SUBMIT_KEYS = new Set(["Enter", "NumpadEnter"]);

export class OperationReviewer extends EventEmitter {
    private policy: ReviewPolicy = "risky-only";
    private prompter: Prompter | undefined;
    private alwaysAllow = new Set<string>();
    private readonly log: LogEntry[] = [];
    private seq = 0;

    setPolicy(p: ReviewPolicy): void {
        this.policy = p;
        this.emit("policy", p);
    }

    getPolicy(): ReviewPolicy {
        return this.policy;
    }

    setPrompter(fn: Prompter | undefined): void {
        this.prompter = fn;
    }

    getLog(): LogEntry[] {
        return [...this.log];
    }

    clearAlwaysAllow(): void {
        this.alwaysAllow.clear();
    }

    /** Classify whether an operation is risky/irreversible or outward-facing. */
    classify(op: Operation): { risky: boolean; reason?: string } {
        // The agent explicitly asking for approval before an outward-facing action.
        if (op.tool === "request_approval") {
            return { risky: true, reason: String(op.args.action ?? "an action others would see") };
        }

        // Acting inside a sensitive area (chat box, Send button, terminal, ...)
        // is risky regardless of what the action itself looks like.
        if (op.sensitive) {
            const where = op.sensitive.app ? ` in ${op.sensitive.app}` : "";
            return { risky: true, reason: `Sensitive area${where}: ${op.sensitive.reason}` };
        }

        const text = this.textOf(op);
        if (text) {
            for (const { re, reason } of DANGEROUS_PATTERNS) {
                if (re.test(text)) return { risky: true, reason };
            }
        }

        // Detectable commit/send/save shortcuts (others would see the result).
        if (op.tool === "hotkey") {
            const codes = (op.args.codes as string[] | undefined) ?? [];
            const set = new Set(codes);
            const ctrl = set.has("ControlLeft") || set.has("ControlRight");
            const meta = set.has("MetaLeft") || set.has("MetaRight");
            const alt = set.has("AltLeft") || set.has("AltRight") || set.has("Alt");
            const enter = set.has("Enter") || set.has("NumpadEnter");
            if (ctrl && alt && set.has("Delete")) return { risky: true, reason: "Ctrl+Alt+Del" };
            if ((ctrl || meta) && enter) return { risky: true, reason: "send/submit shortcut (Ctrl/Cmd+Enter)" };
            if (ctrl && set.has("KeyS")) return { risky: true, reason: "save (Ctrl+S)" };
        }
        return { risky: false };
    }

    /** Extract any free text an op would type, for pattern matching. */
    private textOf(op: Operation): string {
        if (op.tool === "type_text") return String(op.args.text ?? "");
        if (op.tool === "press_key") return String(op.args.key ?? op.args.code ?? "");
        if (op.tool === "hotkey") return ((op.args.codes as string[] | undefined) ?? []).join("+");
        return "";
    }

    private kindOf(op: Operation): string {
        // Sensitive ops key their always-allow per app, so "always allow" means
        // "stop asking while I work in this app" - not "stop asking everywhere".
        if (op.sensitive) return `sensitive:${op.sensitive.app ?? "area"}`;
        // Coarse: tool name is enough for "always allow this kind of action".
        return op.tool;
    }

    /**
     * Review an operation. Resolves to a verdict the caller enforces:
     *  - allow    : run it
     *  - deny     : block; surface `reason` to the agent
     *  - redirect : block; steer the agent with `text`
     */
    async review(op: Operation): Promise<Verdict> {
        const { risky, reason } = this.classify(op);
        const kind = this.kindOf(op);

        const reasonField = reason ? { reason } : {};
        const needsPrompt = this.shouldPrompt(op, risky, kind);
        if (!needsPrompt) {
            this.record({ op, risky, ...reasonField, decision: "auto-allow" });
            return { decision: "allow" };
        }

        const id = `op_${++this.seq}`;
        const req: AuthRequest = { id, op, risky, kind, ...(reason ? { reason } : {}) };

        if (!this.prompter) {
            // No one can authorize. Safe default: allow ordinary navigation, but
            // never auto-run a risky op unattended.
            const verdict: Verdict = risky
                ? { decision: "deny", reason: "No reviewer available to authorize a risky action." }
                : { decision: "allow" };
            this.record({
                op,
                risky,
                ...reasonField,
                decision: verdict.decision === "deny" ? "deny" : "auto-allow",
            });
            return verdict;
        }

        this.emit("prompt", req);
        const verdict = await this.prompter(req);

        if (verdict.rememberKind && verdict.decision === "allow") {
            this.alwaysAllow.add(kind);
        }
        this.record({
            op,
            risky,
            ...reasonField,
            decision: verdict.decision,
            ...(verdict.text ? { redirectText: verdict.text } : {}),
        });
        return verdict;
    }

    private shouldPrompt(op: Operation, risky: boolean, kind: string): boolean {
        // An explicit approval request always prompts, whatever the policy.
        if (op.tool === "request_approval") return true;
        if (this.alwaysAllow.has(kind)) return false;
        // Sensitive areas always prompt (even under autorun-trusted) unless the
        // user has chosen to always-allow this app for the session (handled above).
        if (op.sensitive) return true;
        switch (this.policy) {
            case "review-all":
                return true;
            case "risky-only":
                return risky;
            case "autorun-trusted":
                // Only the hardest deny-list (a strict subset of risky) prompts.
                return risky && this.isHardDeny(op);
        }
    }

    private isHardDeny(op: Operation): boolean {
        const text = this.textOf(op);
        return /\b(shutdown|reboot|poweroff|mkfs|dd\s+if=|drop\s+(table|database))\b/i.test(text);
    }

    private record(e: Omit<LogEntry, "id" | "at">): void {
        const entry: LogEntry = { ...e, id: `log_${this.log.length + 1}`, at: Date.now() };
        this.log.push(entry);
        if (this.log.length > 500) this.log.shift();
        this.emit("log", entry);
    }
}

export { SUBMIT_KEYS };
