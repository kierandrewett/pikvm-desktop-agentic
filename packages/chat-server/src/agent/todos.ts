/**
 * The assistant's working plan: the runtime's `todo` tool returns the whole task list after every call in
 * `details.phases`. The runtime sends no separate todo event, so this result is the only live source; live runs
 * (run.ts) and history (conversations/history.ts) both read it here, so they show the same list.
 *
 * Only the fields the thread shows are kept. Text is bounded so a runaway list cannot bloat every history page.
 */
import type { TodoPhase, TodoStatus } from "@pikvm/chat-protocol";

const STATUSES: ReadonlySet<string> = new Set<TodoStatus>([
    "pending",
    "in_progress",
    "completed",
    "abandoned",
    "blocked",
]);
const MAX_PHASES = 20;
const MAX_TASKS = 100;
const MAX_TEXT = 500;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, MAX_TEXT) : undefined);

/** The task list of a `todo` result, or undefined for other tools and malformed results. */
export function todosFromResult(toolName: string | undefined, details: unknown): TodoPhase[] | undefined {
    if (toolName !== "todo" || !details || typeof details !== "object") return undefined;
    const phases = (details as { phases?: unknown }).phases;
    if (!Array.isArray(phases)) return undefined;
    const out: TodoPhase[] = [];
    for (const p of phases.slice(0, MAX_PHASES)) {
        const name = text((p as { name?: unknown })?.name);
        const tasks = (p as { tasks?: unknown })?.tasks;
        if (!name || !Array.isArray(tasks)) continue;
        const phase: TodoPhase = { name, tasks: [] };
        for (const t of tasks.slice(0, MAX_TASKS)) {
            const content = text((t as { content?: unknown })?.content);
            const status = (t as { status?: unknown })?.status;
            if (!content || typeof status !== "string" || !STATUSES.has(status)) continue;
            const blocker = status === "blocked" ? text((t as { blocker?: unknown }).blocker) : undefined;
            phase.tasks.push({ content, status: status as TodoStatus, ...(blocker ? { blocker } : {}) });
        }
        out.push(phase);
    }
    return out;
}
