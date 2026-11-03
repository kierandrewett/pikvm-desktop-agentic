/**
 * Agent session JSONL -> Responses items.
 *
 * The session file is a tree (id/parentId). The active branch is the chain from the last entry in
 * file order back to the root. Only that branch is converted; user messages on it that were edited carry
 * their `versions` (versions.ts). Results are cached per file by
 * (size, mtime), so reopening a conversation does not re-parse it.
 *
 * Item ids are stable across reads: `<entryId>` for user messages and tool results,
 * `<entryId>.<blockIndex>` for assistant blocks, `<entryId>.end` for the run end note of an assistant
 * message that failed, was stopped or was cut off.
 */
import type { MessageItem, OutputItem, OutputText, RunEndItem, SourceRef, SubagentRun } from "@pikvm/chat-protocol";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { citationsFor, rememberSources, sourcesFromResult } from "../agent/citations.ts";
import { askRecord } from "../agent/questions.ts";
import { sourcesOfRuns, stepsFromItems, subagentsFromResult } from "../agent/subagents.ts";
import { contextTokens, type ModelUsage } from "../agent/context-usage.ts";
import { todosFromResult } from "../agent/todos.ts";
import { toolFacts } from "../agent/tool-facts.ts";
import { indexVersions, type VersionIndex } from "./versions.ts";

interface Entry {
    type: string;
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    message?: AgentMessage;
    summary?: string;
}

interface Block {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    data?: string;
    mimeType?: string;
}

interface AgentMessage {
    role: string;
    content?: string | Block[];
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
    usage?: ModelUsage;
}

export type RunEnd = Omit<RunEndItem, "id" | "type">;

/** The user pressed stop. The runtime's own abort texts ("Interrupted by user", "Request was aborted") are internal. */
export const STOPPED_BY_USER: RunEnd = { status: "cancelled", code: "stopped", message: "You stopped this response." };

/**
 * Provider error text without the runtime's local diagnostics: it appends `raw-http-request=<path>` lines
 * (paths inside the sandbox) to rejected requests, and often repeats the provider's message on a second
 * line with a `(type=...)` suffix. The provider's own words are kept as they are.
 */
export function cleanErrorMessage(message: string | undefined): string {
    const kept: string[] = [];
    for (const raw of (message ?? "").split("\n")) {
        const line = raw.trim();
        if (!line || /^raw-http-request(-save-failed)?=/.test(line)) continue;
        const core = line.replace(/\s*\(type=[^)]*\)$/, "");
        if (kept.some((k) => k.includes(core))) continue;
        kept.push(line);
    }
    return kept.join("\n");
}

/**
 * How a run ended, from its last assistant message. Undefined for a normal end. Shared by the live run
 * (agent/run.ts) and history, so a reload shows the same note as the live response.
 */
export function runEndOf(m: Pick<AgentMessage, "stopReason" | "errorMessage"> | undefined): RunEnd | undefined {
    switch (m?.stopReason) {
        case "error":
            return {
                status: "failed",
                code: "model_error",
                message: cleanErrorMessage(m.errorMessage) || "The model returned an error.",
            };
        case "aborted":
            return STOPPED_BY_USER;
        case "length":
            return {
                status: "incomplete",
                code: "max_output_tokens",
                message: "The response stopped at the model's output limit.",
            };
    }
    return undefined;
}

const BLOB = /^blob:sha256:([0-9a-f]{64})$/;

function imageUrl(conversationId: string, b: Block): string {
    const m = b.data?.match(BLOB);
    if (m) return `/api/conversations/${conversationId}/blobs/${m[1]}`;
    return `data:${b.mimeType ?? "image/png"};base64,${b.data ?? ""}`;
}

function blocks(content: AgentMessage["content"]): Block[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return content ?? [];
}

const textOf = (content: AgentMessage["content"]) =>
    blocks(content)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");

const HIDDEN_MARKERS = [
    "\n\n[Mentioned tools]\n",
    // Which image each composer chip stands for (http/ws.ts markedImagesNote).
    "\n\n[Marked images]\n",
    "\n\n[The user reacted since your last reply.",
    // Plugin documents bound to the chat (plugins/documents.ts documentHint).
    "\n\n[Open document]\n",
];
const FILES_MARKER = "\n\nAttached files:\n";

/**
 * The server appends agent-only notes to the user's text (attachments, mention hints, reaction
 * feedback). Split them back out so the bubble shows what the user typed, with attachments as parts.
 */
export function splitUserText(raw: string): { text: string; files: { uploadId: string; filename: string }[] } {
    let text = raw;
    for (const m of HIDDEN_MARKERS) {
        const i = text.indexOf(m);
        if (i >= 0) text = text.slice(0, i);
    }
    const files: { uploadId: string; filename: string }[] = [];
    const f = text.indexOf(FILES_MARKER);
    if (f >= 0) {
        for (const line of text.slice(f + FILES_MARKER.length).split("\n")) {
            // Indented lines under an entry (its link in the conversation folder, ws.ts) do not match.
            const m = line.match(/^- \/uploads\/([A-Za-z0-9_-]+)\/(.+)$/);
            if (m) files.push({ uploadId: m[1]!, filename: m[2]! });
        }
        text = text.slice(0, f);
    }
    return { text, files };
}

/**
 * Convert one agent message to items. Exported for the live bridge's final reconciliation.
 * `sessionDir` (the session file path without `.jsonl`) holds subagent session files; with it, `task`
 * results get each subagent's steps.
 */
export function messageToItems(
    conversationId: string,
    entryId: string,
    m: AgentMessage,
    sessionDir?: string,
): OutputItem[] {
    const out: OutputItem[] = [];
    if (m.role === "user") {
        const content: MessageItem["content"] = [];
        for (const b of blocks(m.content)) {
            if (b.type === "text") {
                const { text, files } = splitUserText(b.text ?? "");
                if (text) content.push({ type: "input_text", text });
                for (const f of files)
                    content.push({ type: "input_file", upload_id: f.uploadId, filename: f.filename });
            } else if (b.type === "image")
                content.push({ type: "input_image", image_url: imageUrl(conversationId, b) });
        }
        out.push({ id: entryId, type: "message", role: "user", status: "completed", content, created_at: m.timestamp });
    } else if (m.role === "assistant") {
        blocks(m.content).forEach((b, i) => {
            const id = `${entryId}.${i}`;
            if (b.type === "text" && b.text) {
                out.push({
                    id,
                    type: "message",
                    role: "assistant",
                    status: m.stopReason === "aborted" ? "incomplete" : "completed",
                    content: [{ type: "output_text", text: b.text, annotations: [] } satisfies OutputText],
                    created_at: m.timestamp,
                    context_tokens: contextTokens(m.usage) || undefined,
                });
            } else if (b.type === "thinking" && b.thinking) {
                out.push({
                    id,
                    type: "reasoning",
                    status: "completed",
                    summary: [],
                    content: [{ type: "reasoning_text", text: b.thinking }],
                });
            } else if (b.type === "toolCall") {
                out.push({
                    id,
                    type: "function_call",
                    status: "completed",
                    call_id: b.id ?? id,
                    name: b.name ?? "tool",
                    arguments: JSON.stringify(b.arguments ?? {}),
                });
            }
        });
        const end = runEndOf(m);
        if (end) out.push({ id: `${entryId}.end`, type: "chat.run_end", ...end });
    } else if (m.role === "toolResult") {
        const subagents = m.toolName === "task" ? subagentsFromResult(m.details) : undefined;
        if (subagents && sessionDir) withChildSteps(subagents, sessionDir, conversationId);
        out.push({
            id: entryId,
            type: "function_call_output",
            status: "completed",
            call_id: m.toolCallId ?? entryId,
            output: textOf(m.content),
            is_error: m.isError || undefined,
            sources: m.isError ? undefined : (sourcesFromResult(m.toolName, m) ?? sourcesOfRuns(subagents)),
            subagents,
            todos: m.isError ? undefined : todosFromResult(m.toolName, m.details),
            ...toolFacts(m.toolName, m.details, conversationId),
        });
    }
    return out;
}

const ABORT_TEXT = /\babort|interrupt|cancel/i;

/**
 * Flag the tool results that Stop cut short. The session file has no such flag, so this is the one place that
 * infers it: in a turn that ended "stopped", an error result is the stop itself when it belongs to the last call of
 * the turn or says it was aborted. Live runs set `aborted` from the stop request instead (agent/run.ts).
 */
function markStopped(items: OutputItem[]): void {
    let start = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.type === "message" && it.role === "user") start = i + 1;
        if (it.type !== "chat.run_end" || it.status !== "cancelled") continue;
        const turn = items.slice(start, i);
        const lastCall = turn.findLast((x) => x.type === "function_call");
        for (const out of turn) {
            if (out.type !== "function_call_output" || !out.is_error) continue;
            if (
                out.call_id === (lastCall?.type === "function_call" ? lastCall.call_id : undefined) ||
                ABORT_TEXT.test(out.output)
            )
                out.aborted = true;
        }
    }
}

/** Parse a session file and return the active branch as items. `sessionDir`: see `messageToItems`. */
export function parseSession(text: string, conversationId: string, sessionDir?: string): OutputItem[] {
    const byId = new Map<string, Entry>();
    const entries: Entry[] = [];
    let leaf: Entry | undefined;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let e: Entry;
        try {
            e = JSON.parse(line);
        } catch {
            continue; // a torn last line while the runtime is writing
        }
        if (!e.id || e.type === "session" || e.type === "title") continue;
        byId.set(e.id, e);
        entries.push(e);
        leaf = e;
    }
    // Edited messages carry their versions (versions.ts); built only when the branch has a user message.
    let versions: VersionIndex | undefined;
    const chain: Entry[] = [];
    const seen = new Set<string>();
    for (let e = leaf; e?.id && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
        seen.add(e.id);
        chain.push(e);
    }
    chain.reverse();

    const items: OutputItem[] = [];
    // Sources seen so far on the branch; reset at each user message, as in a live response.
    let sources = new Map<string, SourceRef>();
    // Arguments of `ask` calls by call id: their results become question records (as in a live response).
    const asks = new Map<string, string>();
    for (const e of chain) {
        if (e.type === "message" && e.message) {
            if (e.message.role === "user") sources = new Map();
            // The entry's own timestamp is when the runtime wrote the finished message; the message's timestamp is
            // when it started. An assistant message gets the finish time, so a turn's duration covers the whole reply.
            const written = e.timestamp ? Date.parse(e.timestamp) : NaN;
            for (const it of messageToItems(conversationId, e.id!, e.message, sessionDir)) {
                if (it.type === "message" && it.role === "assistant" && Number.isFinite(written))
                    it.completed_at = written;
                if (it.type === "message" && it.role === "user") {
                    const ids = (versions ??= indexVersions(entries)).group(e.id!);
                    if (ids) it.versions = { ids, index: ids.indexOf(e.id!) };
                }
                if (it.type === "function_call" && it.name === "ask") asks.set(it.call_id, it.arguments);
                if (it.type === "function_call_output" && asks.has(it.call_id)) {
                    items.push(
                        askRecord(
                            `${it.id}.ask`,
                            it.call_id,
                            asks.get(it.call_id)!,
                            e.message.details,
                            e.message.isError === true,
                        ),
                    );
                }
                if (it.type === "function_call_output") rememberSources(sources, it.sources);
                else if (it.type === "message" && it.role === "assistant" && it.content[0]?.type === "output_text") {
                    it.content[0].annotations = citationsFor(it.content[0].text, sources);
                }
                items.push(it);
            }
        } else if (e.type === "compaction" && e.summary) {
            items.push({ id: e.id!, type: "chat.compaction", summary: e.summary });
        }
    }
    markStopped(items);
    return items;
}

const cache = new Map<string, { size: number; mtimeMs: number; items: OutputItem[] }>();
const MAX_CACHED = 200;

/** Items for a session file, cached by (size, mtime). Returns [] when the file does not exist yet. */
export async function readSessionItems(file: string, conversationId: string): Promise<OutputItem[]> {
    let st;
    try {
        st = statSync(file);
    } catch {
        return [];
    }
    const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        // Refresh LRU position.
        cache.delete(file);
        cache.set(file, hit);
        return hit.items;
    }
    const items = parseSession(await readFile(file, "utf8"), conversationId, file.replace(/\.jsonl$/, ""));
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, items });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return items;
}

export function forgetSession(file: string): void {
    cache.delete(file);
}

/** Subagent session files are `<sessionDir>/<agentId>.jsonl`; agent ids are runtime-generated words. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Text of one subagent's own session, or undefined when the id is invalid or the file is missing. */
function subagentSession(sessionDir: string, agentId: string): string | undefined {
    if (!AGENT_ID.test(agentId)) return undefined;
    try {
        return readFileSync(join(sessionDir, `${agentId}.jsonl`), "utf8");
    } catch {
        return undefined;
    }
}

/** Items of one subagent's own session, or undefined when the id is invalid or the file is missing. */
export function subagentItems(sessionDir: string, agentId: string, conversationId: string): OutputItem[] | undefined {
    const text = subagentSession(sessionDir, agentId);
    return text === undefined ? undefined : parseSession(text, conversationId, join(sessionDir, agentId));
}

/**
 * The model a session ran on, for `task` results that predate the runtime's `resolvedModel`: the provider and
 * model of its last assistant message, else its last default-role `model_change` entry.
 */
function sessionModel(text: string): string | undefined {
    let answered: string | undefined;
    let changed: string | undefined;
    for (const line of text.split("\n")) {
        if (!line.includes('"assistant"') && !line.includes('"model_change"')) continue;
        let e: {
            type?: string;
            model?: string;
            role?: string;
            message?: { role?: string; provider?: string; model?: string };
        };
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const m = e.message;
        if (e.type === "message" && m?.role === "assistant" && m.provider && m.model) {
            answered = `${m.provider}/${m.model}`;
        } else if (e.type === "model_change" && e.model?.includes("/") && (!e.role || e.role === "default")) {
            changed = e.model;
        }
    }
    return answered ?? changed;
}

/** Fill each run's steps (and tool count) from its session file, when the file exists; and its model when unknown. */
export function withChildSteps(runs: SubagentRun[], sessionDir: string, conversationId: string): SubagentRun[] {
    for (const run of runs) {
        const text = subagentSession(sessionDir, run.id);
        if (text === undefined) continue;
        run.steps = stepsFromItems(parseSession(text, conversationId, join(sessionDir, run.id)));
        run.tool_count = Math.max(run.tool_count, run.steps.length);
        run.model ??= sessionModel(text);
    }
    return runs;
}
