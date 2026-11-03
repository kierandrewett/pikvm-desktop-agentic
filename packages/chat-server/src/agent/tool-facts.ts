/**
 * Structured facts the runtime puts in a tool result's `details`, forwarded on `function_call_output` so clients do
 * not parse them from the result text:
 * - `edit`: `details.diff`, a unified diff with removed lines.
 * - `bash`: `details.wallTimeMs`, and `details.exitCode` (the runtime sets it only for a non-zero exit).
 * Anything that is not a finite number or a non-empty string is dropped.
 */
import type { FunctionCallOutputItem } from "@pikvm/chat-protocol";

type Facts = Pick<FunctionCallOutputItem, "diff" | "exit_code" | "wall_time_ms">;

const MAX_DIFF = 200_000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function toolFacts(toolName: string | undefined, details: unknown): Facts | undefined {
    if (!details || typeof details !== "object") return undefined;
    const d = details as { diff?: unknown; exitCode?: unknown; wallTimeMs?: unknown };
    if (toolName === "edit" && typeof d.diff === "string" && d.diff.trim()) return { diff: d.diff.slice(0, MAX_DIFF) };
    if (toolName === "bash") {
        const facts: Facts = {};
        if (finite(d.exitCode)) facts.exit_code = Math.trunc(d.exitCode);
        if (finite(d.wallTimeMs) && d.wallTimeMs >= 0) facts.wall_time_ms = Math.round(d.wallTimeMs);
        return Object.keys(facts).length ? facts : undefined;
    }
    return undefined;
}
