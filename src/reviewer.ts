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
 * Layered on top of the policy is an *autonomy dial* (0–5) that tunes how
 * eagerly inherently-safe, validated commands are allowed to run without a
 * prompt — so the agent stops asking permission to press Enter on an `ls`,
 * while still always pausing before anything dangerous or anything other
 * people would see. See {@link classifyCommand} and {@link autonomyThreshold}.
 *
 * The authorization prompt is three-way: Allow / Deny / "Do something
 * different" (a free-text redirect that steers the agent onto a new course).
 */

import { EventEmitter } from "events";

export type ReviewPolicy = "risky-only" | "review-all" | "autorun-trusted";
export type Decision = "allow" | "deny" | "redirect";

/**
 * Autonomy dial: 0 = maximum caution (prompt for almost everything),
 * 5 = maximum autonomy (prompt only for genuinely dangerous or
 * outward-facing actions). 3 is the balanced default.
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Risk tier derived purely from the text of a shell-style command:
 *  - "safe"        : read-only / inspection (ls, cat, git status, …).
 *  - "dangerous"   : irreversible or destructive (rm -rf, dd, force push, …).
 *  - "side-effect" : others would see it (send a message, post, submit, …).
 *  - "medium"      : anything else — caution scales with the autonomy dial.
 */
export type CommandRisk = "safe" | "dangerous" | "side-effect" | "medium";

/** British-English labels/descriptions for each rung of the autonomy dial. */
export const AUTONOMY_LABELS: Record<AutonomyLevel, { label: string; description: string }> = {
    0: { label: "Ask first", description: "Prompt before almost every action — maximum caution." },
    1: { label: "Cautious", description: "Auto-run only plainly safe, read-only commands." },
    2: { label: "Measured", description: "Auto-run safe commands; pause on anything unfamiliar." },
    3: { label: "Balanced", description: "Auto-run safe and routine actions; prompt for risky or outward-facing ones." },
    4: { label: "Trusting", description: "Auto-run most things; prompt only for risky or outward-facing actions." },
    5: { label: "Hands-off", description: "Prompt only for genuinely dangerous or outward-facing actions." },
};

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
    /**
     * The command line this op would submit, when known. Set for a submitting
     * keypress (Enter on a terminal/prompt) so the reviewer can classify the
     * command being *run* rather than the bare key. The runner fills this from
     * the most recently typed line when it submits a terminal command.
     */
    commandText?: string;
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

/**
 * Commands that only read/inspect — they have no side effects and are safe to
 * run unattended at higher autonomy. Matched as the *leading* word of a command
 * (after stripping a leading `sudo` is deliberately NOT done — sudo is risky).
 */
const SAFE_COMMANDS = new Set([
    "ls", "ll", "la", "dir", "pwd", "cd", "cat", "bat", "less", "more", "head", "tail",
    "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "locate", "which", "whereis", "type",
    "echo", "printf", "stat", "file", "wc", "du", "df", "tree", "realpath", "basename", "dirname",
    "whoami", "id", "hostname", "uname", "date", "uptime", "env", "printenv", "history", "man",
    "ps", "top", "htop", "free", "lscpu", "lsblk", "lsusb", "lspci", "ip", "ifconfig", "ping",
    // NB: sed/awk are deliberately NOT here — `sed -i` and awk's system()/redirects
    // can mutate, so they fall through to "medium" rather than auto-running.
    "diff", "cmp", "sort", "uniq", "cut", "jq", "column", "tac", "nl",
]);

/** Read-only `git` subcommands (anything else under git falls through to medium/danger). */
const SAFE_GIT_SUBCOMMANDS = new Set([
    // Read-only inspection only — mutating subcommands (stash, checkout, add,
    // commit, …) deliberately fall through to "medium".
    "status", "branch", "log", "diff", "show", "describe", "blame", "remote",
    "rev-parse", "ls-files", "ls-remote", "shortlog", "reflog", "whatchanged",
]);

/**
 * Verbs (CLI subcommands or noun phrases) that produce an outward, human-visible
 * side effect: someone else sees/receives something, or money/commitment moves.
 * These ALWAYS prompt regardless of how "safe" the surrounding command looks.
 */
const SIDE_EFFECT_RE =
    /\b(send|sendmail|post|publish|tweet|toot|comment|reply|submit|pay|purchase|checkout|deploy|release|email|mailx?|message|dm|broadcast|invite|rsvp|share|join)\b/i;

/** Hard-dangerous, irreversible or destructive command shapes. */
const DANGEROUS_COMMAND_RE: RegExp[] = [
    /\brm\s+(-\w*\s+)*-?\w*[rf]\w*/i, // rm with -r/-f in any flag combination
    /\brm\s+-[a-z]*[rf]/i,
    /\b(dd)\s+if=/i,
    /\bmkfs(\.\w+)?\b/i,
    /\b(shutdown|reboot|poweroff|halt)\b/i,
    /\binit\s+0\b/i,
    /\bchmod\s+-R\b/i,
    /\bchown\s+-R\b/i,
    /\bgit\s+push\b.*--force|\bgit\s+push\s+-f\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[a-z]*f/i,
    /\b(format)\s+[a-z]:/i,
    /\bdrop\s+(table|database)\b/i,
    /:\(\)\s*\{.*\};:/, // fork bomb
    /\b(curl|wget)\b.+\|\s*(sudo\s+)?(ba|z|c)?sh\b/i, // pipe remote script to a shell
    /(^|\s|\|)\s*sudo\b/i, // anything under sudo
    />\s*\/dev\/sd[a-z]/i, // writing straight to a block device
    /\b(rm|mv|cp|chmod|chown|tee|truncate)\b[^|;&]*\s\/etc(\/|\b)/i, // mutating /etc
    />>?\s*\/etc(\/|\b)/i, // redirecting output into /etc
];

/**
 * Outward-side-effect verbs, but only when they're the command/sub-command
 * being invoked — not, say, "checkout" inside `git checkout`. A bare word in
 * {@link SIDE_EFFECT_RE} would over-match; this guards the common false hit.
 */
function isBenignGitVerb(clause: string): boolean {
    const words = clause.trim().split(/\s+/);
    return (words[0] ?? "").toLowerCase() === "git" && (words[1] ?? "").toLowerCase() === "checkout";
}

/**
 * Classify a shell-style command purely from its text — no per-app rules.
 * Precedence: side-effect > dangerous > safe > medium. A line is split on
 * `;`, `&&`, `||` and `|` so the *riskiest* clause wins (e.g.
 * `ls && rm -rf foo` is dangerous; `git status | grep foo` is safe).
 */
export function classifyCommand(cmd: string): CommandRisk {
    const trimmed = (cmd ?? "").trim();
    if (!trimmed) return "medium";

    const clauses = trimmed.split(/\s*(?:\|\||&&|;|\||&)\s*/).filter(Boolean);
    if (!clauses.length) return "medium";

    // An outward side effect in any clause dominates — others see it. We test
    // per clause so we can exempt benign uses (e.g. `git checkout`).
    for (const clause of clauses) {
        if (!isBenignGitVerb(clause) && SIDE_EFFECT_RE.test(clause)) return "side-effect";
    }

    // Any dangerous clause makes the whole line dangerous (some patterns span
    // a pipe, e.g. curl | sh, so also test the whole line).
    if (DANGEROUS_COMMAND_RE.some((re) => re.test(trimmed))) return "dangerous";

    // Otherwise the line is safe only if EVERY clause is safe; one unknown
    // clause demotes it to medium (so a hidden mutating command can't ride
    // along behind an `ls`).
    return clauses.every(isSafeClause) ? "safe" : "medium";
}

/** Is a single command clause read-only/inspection? */
function isSafeClause(clause: string): boolean {
    const words = clause.trim().split(/\s+/);
    const head = (words[0] ?? "").toLowerCase();
    if (!head) return false;
    if (head === "git") {
        const sub = (words[1] ?? "").toLowerCase();
        return SAFE_GIT_SUBCOMMANDS.has(sub);
    }
    return SAFE_COMMANDS.has(head);
}

/**
 * Map an autonomy level to the lowest {@link CommandRisk}/op disposition that
 * still auto-runs. Higher autonomy → more is allowed to run silently. Returns
 * the predicate "may this risk tier auto-run at this level?".
 *
 * - "dangerous" and "side-effect" NEVER auto-run (handled before this).
 * - "safe" auto-runs from level 1 upward.
 * - "medium" auto-runs only at the top of the dial (levels 4–5).
 */
export function autonomyThreshold(level: AutonomyLevel): (risk: CommandRisk) => boolean {
    return (risk: CommandRisk): boolean => {
        if (risk === "dangerous" || risk === "side-effect") return false;
        if (risk === "safe") return level >= 1;
        // medium
        return level >= 4;
    };
}

// Module-level so it's monotonic for the WHOLE process — survives a Reviewer being
// recreated (new session, etc.). A per-instance counter reset to 0 each time, which is
// how `op_1` came back and collided with a client's remembered decision → silent hang.
let GLOBAL_OP_SEQ = 0;

export class OperationReviewer extends EventEmitter {
    private policy: ReviewPolicy = "risky-only";
    private autonomy: AutonomyLevel = 3;
    private prompter: Prompter | undefined;
    private alwaysAllow = new Set<string>();
    private readonly log: LogEntry[] = [];

    setPolicy(p: ReviewPolicy): void {
        this.policy = p;
        this.emit("policy", p);
    }

    getPolicy(): ReviewPolicy {
        return this.policy;
    }

    /** Set the autonomy dial (0–5). Out-of-range values are clamped. */
    setAutonomy(level: number): void {
        const clamped = Math.max(0, Math.min(5, Math.round(level))) as AutonomyLevel;
        this.autonomy = clamped;
        this.emit("autonomy", clamped);
    }

    getAutonomy(): AutonomyLevel {
        return this.autonomy;
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

    /**
     * Classify an operation. `risky` means "irreversible or outward-facing"
     * (always worth a prompt at the cautious end). `commandRisk` is the finer
     * tier from {@link classifyCommand} for any command text the op carries —
     * it lets the autonomy dial auto-run inherently-safe commands.
     */
    classify(op: Operation): { risky: boolean; reason?: string; commandRisk: CommandRisk } {
        // The agent explicitly asking for approval before an outward-facing action.
        if (op.tool === "request_approval") {
            return { risky: true, reason: String(op.args.action ?? "an action others would see"), commandRisk: "side-effect" };
        }

        // Acting inside a sensitive area (chat box, Send button, terminal, ...)
        // is risky regardless of what the action itself looks like.
        if (op.sensitive) {
            const where = op.sensitive.app ? ` in ${op.sensitive.app}` : "";
            return { risky: true, reason: `Sensitive area${where}: ${op.sensitive.reason}`, commandRisk: "medium" };
        }

        // A submitting keypress (Enter) carries the command it would run: classify
        // the command itself so a safe `ls`/`git status` can auto-run, while a
        // dangerous or outward-facing one always prompts.
        const command = this.commandOf(op);
        if (command) {
            const commandRisk = classifyCommand(command);
            if (commandRisk === "side-effect") return { risky: true, reason: `Outward action: ${command.slice(0, 60)}`, commandRisk };
            if (commandRisk === "dangerous") return { risky: true, reason: `Dangerous command: ${command.slice(0, 60)}`, commandRisk };
            // safe / medium fall through (no `risky`, dial decides via commandRisk).
            return { risky: false, commandRisk };
        }

        const text = this.textOf(op);
        if (text) {
            for (const { re, reason } of DANGEROUS_PATTERNS) {
                if (re.test(text)) return { risky: true, reason, commandRisk: "dangerous" };
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
            if (ctrl && alt && set.has("Delete")) return { risky: true, reason: "Ctrl+Alt+Del", commandRisk: "dangerous" };
            if ((ctrl || meta) && enter) return { risky: true, reason: "send/submit shortcut (Ctrl/Cmd+Enter)", commandRisk: "side-effect" };
            if (ctrl && set.has("KeyS")) return { risky: true, reason: "save (Ctrl+S)", commandRisk: "side-effect" };
        }
        return { risky: false, commandRisk: "medium" };
    }

    /**
     * The command line an op would submit, if any. A submit keypress (Enter)
     * carries the most recently typed line via `op.commandText`; we only treat
     * Enter as a command submission so ordinary text entry is unaffected.
     */
    private commandOf(op: Operation): string {
        if (op.tool !== "press_key") return "";
        const key = String(op.args.key ?? op.args.code ?? "");
        if (!SUBMIT_KEYS.has(key)) return "";
        return (op.commandText ?? "").trim();
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
     * Non-blocking classification for an EXTERNAL permission layer (Claude Code's own
     * terminal prompts, via the PreToolUse hook → /api/permcheck). Same brain as
     * review() — policy, autonomy dial, always-allow, dangerous-command + sensitive-area
     * detection — but returns the decision instead of prompting. "ask" → Claude Code
     * shows its prompt; "allow" → auto-run. (We never hard-"deny" here: a clearly-stated
     * dangerous op still gets an "ask" so the user can consciously approve it.)
     */
    assess(op: Operation): { decision: "allow" | "ask" | "deny"; reason?: string; risky: boolean } {
        const { risky, reason, commandRisk } = this.classify(op);
        const kind = this.kindOf(op);
        const needsPrompt = this.shouldPrompt(op, risky, kind, commandRisk);
        return { decision: needsPrompt ? "ask" : "allow", risky, ...(reason ? { reason } : {}) };
    }

    /**
     * Review an operation. Resolves to a verdict the caller enforces:
     *  - allow    : run it
     *  - deny     : block; surface `reason` to the agent
     *  - redirect : block; steer the agent with `text`
     */
    async review(op: Operation): Promise<Verdict> {
        const { risky, reason, commandRisk } = this.classify(op);
        const kind = this.kindOf(op);

        const reasonField = reason ? { reason } : {};
        const needsPrompt = this.shouldPrompt(op, risky, kind, commandRisk);
        if (!needsPrompt) {
            this.record({ op, risky, ...reasonField, decision: "auto-allow" });
            return { decision: "allow" };
        }

        // Globally unique — NEVER reused across runs/sessions/restarts. A reused id
        // (the old per-instance `op_${seq}` reset to op_1) collided with a client's
        // still-remembered "decided" id from a prior run, so the new request looked
        // already-approved → the approve UI never showed and the agent hung forever.
        // Module-level counter + a time suffix → unique within a process AND across
        // restarts (a fresh process starts seconds later, so Date.now differs).
        const id = `op_${++GLOBAL_OP_SEQ}_${Date.now().toString(36)}`;
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

    private shouldPrompt(op: Operation, risky: boolean, kind: string, commandRisk: CommandRisk): boolean {
        // An explicit approval request always prompts, whatever the policy.
        if (op.tool === "request_approval") return true;
        if (this.alwaysAllow.has(kind)) return false;
        // Dangerous/irreversible commands and outward, human-visible actions
        // ALWAYS prompt — at every autonomy level and under every policy.
        if (commandRisk === "dangerous" || commandRisk === "side-effect") return true;
        // Sensitive areas always prompt (even under autorun-trusted) unless the
        // user has chosen to always-allow this app for the session (handled above).
        if (op.sensitive) return true;
        switch (this.policy) {
            case "review-all":
                return true;
            case "risky-only": {
                // The autonomy dial decides for non-risky command ops: a safe
                // `ls`/`git status` (or, high up the dial, a medium command)
                // auto-runs without a prompt.
                if (this.autonomyAllows(commandRisk)) return false;
                // At the cautious floor (level 0) we prompt for everything that
                // wasn't explicitly allowed above — maximum caution.
                if (this.autonomy === 0) return true;
                return risky;
            }
            case "autorun-trusted":
                // Only the hardest deny-list (a strict subset of risky) prompts.
                return risky && this.isHardDeny(op);
        }
    }

    /** Does the current autonomy dial allow this command-risk tier to auto-run? */
    private autonomyAllows(risk: CommandRisk): boolean {
        return autonomyThreshold(this.autonomy)(risk);
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

export { SUBMIT_KEYS, SAFE_COMMANDS, SAFE_GIT_SUBCOMMANDS };
