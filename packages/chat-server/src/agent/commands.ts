/**
 * Runtime slash commands: which of the runtime's own commands a web user may run.
 *
 * In RPC mode a prompt that starts with `/<name>` runs the runtime's builtin of that name when it has a handler, and
 * answers with `command_output` instead of a model turn. Some builtins leave the sandbox or bypass Chat's settings
 * and policies: `/share` uploads the session to the runtime vendor's server, `/model` and `/switch` skip the model
 * policy, `/fast` changes the cost tier, `/marketplace` installs code. So the server refuses every builtin name that
 * is not in `ALLOWED_RUNTIME_COMMANDS`. Skills (`/skill:<name>`) and words that are not builtin names pass through
 * unchanged (the runtime sends those to the model as text).
 *
 * `RUNTIME_BUILTINS` is the runtime's builtin command names and aliases (slash-commands/builtin-*.ts of the pinned
 * runtime version). Update it with the runtime; docs/spec/runtime-parity.md has the reasoning per command.
 */

/** Builtins that make sense from a web composer: listed by GET /api/commands and allowed in a prompt. */
export const ALLOWED_RUNTIME_COMMANDS: ReadonlySet<string> = new Set([
    "compact",
    "shake",
    "handoff",
    "retry",
    "todo",
    "context",
    "usage",
    "tools",
    "memory",
    "dump",
]);

const RUNTIME_BUILTINS: ReadonlySet<string> = new Set([
    ...ALLOWED_RUNTIME_COMMANDS,
    // Session, model and cost controls that Chat owns through settings, the model picker and policy.
    "model",
    "models",
    "switch",
    "fast",
    "slow",
    "skillful",
    "extended-context",
    "modelpreset",
    "effort",
    "advisor",
    "prewalk",
    "force",
    "fresh",
    "pin",
    "rename",
    "session",
    "jobs",
    "changelog",
    // Leave the sandbox or publish data.
    "share",
    "stats",
    "trace",
    "export",
    "collab",
    "join",
    "leave",
    "live",
    "record",
    "pause",
    // Install code or change connections outside settings.
    "marketplace",
    "plugins",
    "plugin",
    "reload-plugins",
    "mcp",
    "ssh",
    "smithery-search",
    "skills",
    "update",
    "extensions",
    "status",
    "agents",
    "login",
    "logout",
    "settings",
    "setup",
    "providers",
    // Workspace and tool toggles.
    "move",
    "wt",
    "worktree",
    "add-dir",
    "remove-dir",
    "dirs",
    "computer",
    "browser",
    "ratchet",
    "security",
    "git",
    "hub",
    "debug",
    "cleanse",
    // Terminal-only (sent to the model as text in RPC mode): refused so the model never sees a stray command.
    "plan",
    "plan-review",
    "vibe",
    "goal",
    "guided-goal",
    "loop",
    "queue",
    "btw",
    "tan",
    "omfg",
    "branch",
    "rewind",
    "fork",
    "tree",
    "new",
    "clear",
    "delete",
    "resume",
    "copy",
    "open",
    "hotkeys",
    "quit",
    "q",
    "exit",
    "restart",
]);

/**
 * The runtime builtin a prompt would run, when Chat does not allow it; undefined when the prompt may go through.
 * Only the first word counts. The runtime also splits a command from its arguments at `:` (`/share:`), so the
 * name ends at whitespace, `:` or the end of the text.
 */
export function blockedRuntimeCommand(text: string): string | undefined {
    const m = text.trimStart().match(/^\/([a-z][a-z-]*)(?=[\s:]|$)/i);
    if (!m) return undefined;
    const name = m[1]!.toLowerCase();
    return RUNTIME_BUILTINS.has(name) && !ALLOWED_RUNTIME_COMMANDS.has(name) ? name : undefined;
}
