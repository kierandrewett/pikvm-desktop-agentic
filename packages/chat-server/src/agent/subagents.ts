/**
 * Subagents started by the runtime's `task` tool, as `SubagentRun` records for the wire.
 *
 * The runtime reports a blocking `task` call through `tool_execution_update` frames whose
 * `details.progress[]` holds one snapshot per subagent, and a final `details.results[]`. A snapshot
 * only keeps the last five finished tool calls, so the tracker accumulates every step it has seen
 * (keyed by tool, arguments and end time). After the call ends, the subagent's own session file
 * (`<session>/<agentId>.jsonl`) is the complete record; `stepsFromItems` turns its items into steps.
 *
 * Pure: no file access here. history.ts reads the child session files.
 */
import type { OutputItem, SourceRef, SubagentRun, SubagentStep } from "@pikvm/chat-protocol";

interface RecentTool {
    tool: string;
    args?: string;
    intent?: string;
    isError?: boolean;
    endMs: number;
}

interface Progress {
    index: number;
    id: string;
    agent?: string;
    status: string;
    task?: string;
    assignment?: string;
    lastIntent?: string;
    currentTool?: string;
    currentToolArgs?: string;
    currentToolIntent?: string;
    recentTools?: RecentTool[];
    toolCount?: number;
    tokens?: number;
    durationMs?: number;
    resolvedModel?: string;
    resolvedModelIdentity?: string;
}

interface Result {
    index?: number;
    id: string;
    agent?: string;
    task?: string;
    assignment?: string;
    exitCode?: number;
    output?: string;
    aborted?: boolean;
    abortReason?: string;
    error?: string;
    durationMs?: number;
    tokens?: number;
    retryFailure?: { errorMessage?: string };
    resolvedModel?: string;
    resolvedModelIdentity?: string;
}

/** Thinking-level suffix the runtime adds to `resolvedModel` when the level was set explicitly. */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;

/**
 * The catalogue id (`provider/modelId`) a subagent ran on. `resolvedModel` is `<provider>/<id>`, with a
 * `:<thinking>` suffix when the level was explicit; `resolvedModelIdentity` is the same id with an `@<route>`
 * suffix for routed models, used only when the selector is missing.
 */
export function modelOf(p: { resolvedModel?: string; resolvedModelIdentity?: string }): string | undefined {
    const m = p.resolvedModel?.replace(THINKING_SUFFIX, "") || p.resolvedModelIdentity?.replace(/@[^/@]*$/, "");
    return m && m.includes("/") ? m : undefined;
}

interface TaskDetails {
    progress?: Progress[];
    results?: Result[];
}

/** Tools that are plumbing, not work: the subagent's result submission. */
const HIDDEN_TOOLS = new Set(["yield"]);
const ASSIGNMENT_PREFIX = /^Complete assignment thoroughly:\s*/;
const MAX_RESULT = 8000;
const MAX_STEP_SOURCES = 8;

const oneLine = (s: string, max = 160) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

function taskDetails(details: unknown): TaskDetails | undefined {
    if (!details || typeof details !== "object") return undefined;
    const d = details as TaskDetails;
    return Array.isArray(d.progress) || Array.isArray(d.results) ? d : undefined;
}

function assignmentOf(p: { assignment?: string; task?: string }): string {
    return (p.assignment ?? p.task ?? "").replace(ASSIGNMENT_PREFIX, "").trim();
}

/** A user stop reads "Interrupted by user"; anything else that aborts a subagent is a failure. */
const isUserStop = (reason: string | undefined) => !!reason && /interrupt|cancel/i.test(reason);

/** One-line argument preview for a tool call, from its JSON arguments. */
export function argPreview(args: string | Record<string, unknown> | undefined): string {
    let a: Record<string, unknown> | undefined;
    if (typeof args === "string") {
        try {
            a = JSON.parse(args);
        } catch {
            return oneLine(args);
        }
    } else a = args;
    if (!a || typeof a !== "object") return "";
    for (const k of ["command", "cmd", "query", "path", "url", "pattern", "file_path", "q", "name"]) {
        if (typeof a[k] === "string" && a[k]) return oneLine(a[k] as string);
    }
    const first = Object.entries(a).find(([k, v]) => k !== "i" && typeof v === "string" && v);
    return first ? oneLine(first[1] as string) : "";
}

/** Accumulates live progress for one `task` call. */
export class SubagentTracker {
    #runs = new Map<string, { index: number; run: SubagentRun; seen: Set<string>; running?: SubagentStep }>();

    #entry(id: string, index: number, agent: string | undefined, task: string) {
        let e = this.#runs.get(id);
        if (!e) {
            e = {
                index,
                seen: new Set(),
                run: { id, agent: agent ?? "task", task, status: "pending", duration_ms: 0, steps: [], tool_count: 0 },
            };
            this.#runs.set(id, e);
        }
        return e;
    }

    #list(): SubagentRun[] {
        return [...this.#runs.values()]
            .sort((a, b) => a.index - b.index)
            .map((e) => ({ ...e.run, steps: e.running ? [...e.run.steps, e.running] : [...e.run.steps] }));
    }

    /** Apply a progress update. Returns the runs, or undefined when the details are not a task's. */
    update(details: unknown, now = Date.now()): SubagentRun[] | undefined {
        const d = taskDetails(details);
        if (!d) return undefined;
        for (const p of d.progress ?? []) {
            const e = this.#entry(p.id, p.index, p.agent, assignmentOf(p));
            const r = e.run;
            // "aborted" covers both a user stop and a subagent that gave up; only the final result says which,
            // so keep the current status until then.
            if (p.status !== "aborted") {
                r.status = p.status === "failed" ? "failed" : p.status === "completed" ? "completed" : p.status === "running" ? "running" : "pending";
            }
            r.duration_ms = p.durationMs ?? r.duration_ms;
            if (r.status !== "pending" && r.started_at === undefined) r.started_at = now - (p.durationMs ?? 0);
            r.tool_count = p.toolCount ?? r.tool_count;
            if (p.tokens) r.tokens = p.tokens;
            const model = modelOf(p);
            if (model) r.model = model;
            // recentTools is newest first; append unseen ones oldest first.
            for (const t of [...(p.recentTools ?? [])].reverse()) {
                const key = `${t.endMs}:${t.tool}:${t.args ?? ""}`;
                if (e.seen.has(key) || HIDDEN_TOOLS.has(t.tool)) continue;
                e.seen.add(key);
                r.steps.push({ tool: t.tool, label: oneLine(t.args ?? ""), intent: t.intent || undefined, status: t.isError ? "failed" : "completed" });
            }
            e.running =
                r.status === "running" && p.status !== "aborted" && p.currentTool && !HIDDEN_TOOLS.has(p.currentTool)
                    ? { tool: p.currentTool, label: oneLine(p.currentToolArgs ?? ""), intent: p.currentToolIntent || undefined, status: "running" }
                    : undefined;
            r.now = r.status === "running" && p.status !== "aborted" ? (e.running ? e.running.intent || describe(e.running) : p.lastIntent || undefined) : undefined;
        }
        return this.#list();
    }

    /** Apply the final result. Returns the settled runs, or undefined when the details are not a task's. */
    finish(details: unknown, now = Date.now()): SubagentRun[] | undefined {
        const d = taskDetails(details);
        if (!d) return undefined;
        if (d.progress?.length) this.update(details, now);
        for (const [i, res] of (d.results ?? []).entries()) {
            const e = this.#entry(res.id, res.index ?? i, res.agent, assignmentOf(res));
            e.running = undefined;
            Object.assign(e.run, settle(res));
            if (e.run.started_at === undefined) e.run.started_at = now - e.run.duration_ms;
        }
        return this.#list();
    }
}

/** Status, timings and output of a settled subagent. */
function settle(res: Result): Partial<SubagentRun> {
    const failedReason = res.error ?? res.retryFailure?.errorMessage;
    const status: SubagentRun["status"] = res.aborted
        ? isUserStop(res.abortReason)
            ? "cancelled"
            : "failed"
        : failedReason || (res.exitCode ?? 0) !== 0
          ? "failed"
          : "completed";
    const output = (res.output ?? "").trim();
    const model = modelOf(res);
    return {
        ...(model ? { model } : {}),
        status,
        now: undefined,
        duration_ms: res.durationMs ?? 0,
        tokens: res.tokens || undefined,
        result: status === "completed" && output ? output.slice(0, MAX_RESULT) : undefined,
        error: status === "completed" ? undefined : (failedReason ?? res.abortReason ?? (status === "failed" ? "The subagent failed" : undefined)),
    };
}

/** Settled runs straight from a persisted `task` result (history), without live progress. */
export function subagentsFromResult(details: unknown): SubagentRun[] | undefined {
    const d = taskDetails(details);
    if (!d?.results?.length) return undefined;
    return d.results.map((res) => {
        const settled = settle(res);
        return {
            id: res.id,
            agent: res.agent ?? "task",
            task: assignmentOf(res),
            steps: [],
            tool_count: 0,
            ...settled,
            status: settled.status!,
            duration_ms: settled.duration_ms ?? 0,
        };
    });
}

/** Steps of a subagent from the items of its own session (function calls and their outputs). */
export function stepsFromItems(items: readonly OutputItem[]): SubagentStep[] {
    const outputs = new Map<string, Extract<OutputItem, { type: "function_call_output" }>>();
    for (const it of items) if (it.type === "function_call_output") outputs.set(it.call_id, it);
    const steps: SubagentStep[] = [];
    for (const it of items) {
        if (it.type !== "function_call" || HIDDEN_TOOLS.has(it.name)) continue;
        const out = outputs.get(it.call_id);
        let intent: string | undefined;
        try {
            const i = (JSON.parse(it.arguments) as { i?: unknown }).i;
            if (typeof i === "string" && i) intent = oneLine(i, 120);
        } catch {}
        steps.push({
            tool: it.name,
            label: argPreview(it.arguments),
            intent,
            status: !out ? "running" : out.is_error ? "failed" : "completed",
            sources: out?.sources?.slice(0, MAX_STEP_SOURCES),
        });
    }
    return steps;
}

/** Every web source the runs' steps found, first occurrence first. */
export function sourcesOfRuns(runs: readonly SubagentRun[] | undefined): SourceRef[] | undefined {
    const seen = new Set<string>();
    const out: SourceRef[] = [];
    for (const r of runs ?? []) {
        for (const s of r.steps) {
            for (const src of s.sources ?? []) {
                if (seen.has(src.url)) continue;
                seen.add(src.url);
                out.push(src);
            }
        }
    }
    return out.length ? out : undefined;
}

/** Plain words for a running step without an intent ("Running ls -la", "Searching the web"). */
function describe(s: SubagentStep): string {
    const n = s.tool.toLowerCase();
    if (n === "web_search") return s.label ? `Searching for ${s.label}` : "Searching the web";
    if (/^https?:\/\//.test(s.label)) return `Reading ${s.label.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}`;
    if (/bash|shell|exec/.test(n)) return s.label ? `Running ${s.label}` : "Running a command";
    if (/edit|write/.test(n)) return s.label ? `Editing ${s.label.split("/").at(-1)}` : "Editing a file";
    if (n === "read") return s.label ? `Reading ${s.label.split("/").at(-1)}` : "Reading files";
    if (/grep|glob|find/.test(n)) return "Searching files";
    return `Using ${s.tool}`;
}
