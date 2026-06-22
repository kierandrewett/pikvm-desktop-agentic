/**
 * Slash-command registry.
 *
 * A declarative table of harness commands parsed from the chat input. Each maps
 * to a control surface on the agent runner / reviewer / presence. Parsing is
 * shared between the renderer (for autocomplete) and the server (for dispatch);
 * an unknown `/x` is treated as ordinary chat.
 */

export interface CommandSpec {
    name: string;
    /** Argument hint, e.g. "<text>". */
    arg?: string;
    summary: string;
}

export const COMMANDS: CommandSpec[] = [
    { name: "goal", arg: "[text]", summary: "Set a persistent goal pinned into every turn (no text = show current)." },
    { name: "btw", arg: "<text>", summary: "Inject a side note mid-run without interrupting the task." },
    { name: "loop", arg: "[count] <task>", summary: "Repeat a task until /stop (or N times)." },
    { name: "pursue", arg: "[cap] <goal>", summary: "Pursue a goal with blind self-verification, iterating until done (or N tries)." },
    { name: "pause", summary: "Pause automation (manual do-not-disturb)." },
    { name: "resume", summary: "Resume automation." },
    { name: "stop", summary: "Stop the agent / loop." },
    { name: "clear", summary: "Clear the conversation transcript." },
    { name: "retry", summary: "Retry the last task." },
    { name: "screenshot", summary: "Capture the screen into the log." },
    { name: "model", arg: "<id>", summary: "Switch the model (e.g. gpt-5.5)." },
    { name: "policy", arg: "<risky-only|review-all|autorun-trusted>", summary: "Set the review policy." },
    { name: "help", summary: "List commands." },
];

export interface ParsedCommand {
    name: string;
    arg: string;
    known: boolean;
}

/** Parse a chat input. Returns null if it isn't a slash command. */
export function parseCommand(input: string): ParsedCommand | null {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return null;
    const m = trimmed.match(/^\/(\w+)\s*([\s\S]*)$/);
    if (!m) return null;
    const name = m[1]!.toLowerCase();
    return { name, arg: (m[2] ?? "").trim(), known: COMMANDS.some((c) => c.name === name) };
}

/** Filter commands for autocomplete given a partial "/pre" input. */
export function completions(input: string): CommandSpec[] {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const prefix = trimmed.slice(1).split(/\s/)[0]!.toLowerCase();
    return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/** Parse a /loop argument into an optional iteration count and the task. */
export function parseLoopArg(arg: string): { count?: number; task: string } {
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (m) return { count: parseInt(m[1]!, 10), task: m[2]!.trim() };
    return { task: arg.trim() };
}

/** Parse a /pursue argument into an optional iteration cap and the goal. */
export function parsePursueArg(arg: string): { cap?: number; goal: string } {
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (m) return { cap: parseInt(m[1]!, 10), goal: m[2]!.trim() };
    return { goal: arg.trim() };
}
