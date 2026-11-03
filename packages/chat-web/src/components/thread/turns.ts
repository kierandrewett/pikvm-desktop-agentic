/**
 * Pure thread logic: merge history with the live response, group items into turns, and the small
 * formatting helpers the turn components share. No React here.
 */
import type {
    ApprovalRequestItem,
    CompactionItem,
    FunctionCallItem,
    FunctionCallOutputItem,
    InputFile,
    InputImage,
    MessageItem,
    OutputItem,
    ReasoningItem,
    ResponseObject,
    RunEndItem,
    SubagentRun,
} from "@pikvm/chat-protocol";
import type { LiveNotice, LiveState } from "../../lib/live";
import { activeLocalization, translate } from "../../l10n/runtime";

export type ActivityItem = ReasoningItem | FunctionCallItem | FunctionCallOutputItem | ApprovalRequestItem;

/** Live response facts a turn needs; history turns have none. */
export interface TurnLive {
    status: ResponseObject["status"];
    done: boolean;
    /** Response start, ms since epoch. */
    startedAt: number;
    durationMs?: number;
    /** The user asked to stop and the server has not ended the response yet. */
    stopping?: boolean;
    /** The prompt waits for a free agent: 1 is next (`chat.queue`). */
    queue?: number;
    /** Runtime notices raised during this response (`chat.notice`). */
    notices?: LiveNotice[];
}

export interface Turn {
    key: string;
    user?: MessageItem;
    items: OutputItem[];
    live?: TurnLive;
    /** A slash command answered by the runtime itself: shown as a compact notice, not a chat turn. */
    local?: boolean;
}

export type ThreadEntry = { kind: "turn"; turn: Turn } | { kind: "compaction"; item: CompactionItem };

const isUser = (i: OutputItem): i is MessageItem => i.type === "message" && i.role === "user";

/** Group a flat item list into turns. A user message starts a turn; compaction markers stand alone. */
export function buildEntries(items: readonly OutputItem[]): ThreadEntry[] {
    const out: ThreadEntry[] = [];
    let cur: Turn | undefined;
    for (const it of items) {
        if (it.type === "chat.compaction") {
            cur = undefined;
            out.push({ kind: "compaction", item: it });
        } else if (isUser(it)) {
            cur = { key: it.id, user: it, items: [] };
            out.push({ kind: "turn", turn: cur });
        } else {
            if (!cur) {
                cur = { key: `lead_${it.id}`, items: [] };
                out.push({ kind: "turn", turn: cur });
            }
            cur.items.push(it);
        }
    }
    return out;
}

// Baseline user-message count of history when each optimistic message was first seen.
const baselines = new Map<string, number>();

const countUsers = (items: readonly OutputItem[]) => items.reduce((n, i) => n + (isUser(i) ? 1 : 0), 0);

/**
 * Split history and live state into the stored part (`history.slice(0, cut)`, rendered as memoised history turns) and the live
 * turn. Rules:
 * - Optimistic send (`pendingInput`) and history has not caught up: history + pending + live output.
 * - Otherwise (resumed after reload, or history already holds the new message): every history item
 *   after the last user message belongs to the running response, so render history up to that user
 *   message and the live output after it. This never shows an item twice.
 */
export function splitLive(
    history: readonly OutputItem[] | undefined,
    live: LiveState | undefined,
): { cut: number; liveTurn?: Turn } {
    const h = history ?? [];
    if (!live) return { cut: h.length };
    const r = live.response;
    const tl: TurnLive = {
        status: r.status,
        done: live.done,
        startedAt: r.created_at * 1000,
        durationMs: r.duration_ms,
        stopping: live.stopping,
        queue: live.queue,
        notices: live.notices,
    };
    const ownTurn = (): Turn => ({ key: `live_${r.id}`, items: r.output, live: tl, local: r.local });
    if (r.local) return { cut: h.length, liveTurn: ownTurn() };
    const pending = live.pendingInput;
    if (pending) {
        if (!baselines.has(pending.id)) baselines.set(pending.id, countUsers(h));
        // History holds the pending message only when it gained a user message and the newest one is this text. The
        // count alone is not enough: history that was empty or stale when the send started (a new chat that has
        // just finished its first turn) gains the previous message later, and that must not replace this turn.
        const lastUser = h.findLast(isUser) as MessageItem | undefined;
        const stored =
            countUsers(h) > baselines.get(pending.id)! &&
            !!lastUser &&
            messageText(lastUser).trim() === messageText(pending).trim();
        if (!stored) {
            return { cut: h.length, liveTurn: { key: pending.id, user: pending, items: r.output, live: tl } };
        }
    }
    let last = -1;
    for (let i = h.length - 1; i >= 0; i--) {
        if (isUser(h[i]!)) {
            last = i;
            break;
        }
    }
    if (last < 0) return { cut: h.length, liveTurn: ownTurn() };
    const user = h[last] as MessageItem;
    // A response started after the stored turn finished (an agent command sent without a user bubble)
    // gets its own turn: the stored turn already has assistant output older than this response.
    // A user message with nothing after it is the start of this response (resumed after a reload),
    // even when the sandbox took a while to start, so it keeps its bubble.
    const startMs = tl.startedAt - 2000;
    const older = h
        .slice(last + 1)
        .some((i) => i.type === "message" && i.created_at !== undefined && i.created_at < startMs);
    if (older) return { cut: h.length, liveTurn: ownTurn() };
    return { cut: last, liveTurn: { key: user.id, user, items: r.output, live: tl } };
}

/** Text of a message's text parts. */
/** The parts of a user message that can be sent again: uploaded or inline images, uploaded files. */
export function resendable(user: MessageItem): (InputImage | InputFile)[] {
    return user.content.filter(
        (p): p is InputImage | InputFile =>
            p.type === "input_file" || (p.type === "input_image" && (!!p.upload_id || p.image_url.startsWith("data:"))),
    );
}

export function messageText(m: MessageItem): string {
    let s = "";
    for (const p of m.content) if (p.type === "input_text" || p.type === "output_text") s += p.text;
    return s;
}

/**
 * Layout of one turn's output: the activity group (everything up to and including the last
 * non-message item, so intermediate assistant text sits inside it), the final answer after it, and the
 * run-end note of a stopped, failed or cut-off turn (always last, never part of the group).
 */
export function splitTurn(items: readonly OutputItem[]): {
    group: OutputItem[];
    final: MessageItem[];
    end?: RunEndItem;
} {
    const last = items.at(-1);
    const end = last?.type === "chat.run_end" ? last : undefined;
    const body = end ? items.slice(0, -1) : items;
    let lastActivity = -1;
    for (let i = body.length - 1; i >= 0; i--) {
        if (body[i]!.type !== "message") {
            lastActivity = i;
            break;
        }
    }
    const final = body
        .slice(lastActivity + 1)
        .filter((i): i is MessageItem => i.type === "message" && i.role === "assistant");
    return { group: body.slice(0, lastActivity + 1).filter((i) => i.type !== "chat.run_end"), final, end };
}

/**
 * A subagent's transcript as one turn for the thread's own renderer (`TurnView`): its work without the
 * assignment message (the panel header shows it) and without the `yield` call that hands the result back.
 * The result becomes the turn's answer; a failed or stopped run ends with a run-end note, as a main turn does.
 * `running` makes it a live turn, so the activity header and the clock run as in the thread.
 */
export function subagentTurn(key: string, items: readonly OutputItem[], run?: SubagentRun, running = false): Turn {
    const yields = new Set(items.flatMap((i) => (i.type === "function_call" && i.name === "yield" ? [i.call_id] : [])));
    const body = items.filter(
        (i) =>
            !(i.type === "message" && i.role === "user") &&
            !((i.type === "function_call" || i.type === "function_call_output") && yields.has(i.call_id)) &&
            i.type !== "chat.run_end",
    );
    const answered = body.at(-1)?.type === "message";
    if (run?.status === "completed" && run.result && !answered) {
        body.push({
            id: `${key}.result`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: resultMarkdown(run.result), annotations: [] }],
        });
    }
    if (run?.status === "failed" || run?.status === "cancelled") {
        body.push({
            id: `${key}.end`,
            type: "chat.run_end",
            status: run.status,
            code: run.status === "failed" ? "subagent_failed" : "stopped",
            message: run.error ?? (run.status === "failed" ? "The subagent failed." : ""),
        });
    }
    const live: TurnLive | undefined = running
        ? { status: "in_progress", done: false, startedAt: run?.started_at ?? Date.now(), durationMs: run?.duration_ms }
        : undefined;
    return { key, items: body, live };
}

/**
 * A subagent's yielded result as markdown: a string as written, a lone string field as its text, a flat
 * object as a list of fields, anything else as a JSON block.
 */
export function resultMarkdown(result: string): string {
    let value: unknown;
    try {
        value = JSON.parse(result);
    } catch {
        return result;
    }
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1] as string;
        if (entries.every(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)))
            return entries.map(([k, v]) => `- **${k}**: ${String(v)}`).join("\n");
    }
    return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

/** "7s", "1m 37s", "1h 4m". */
export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Duration of a stored turn: user message to the last assistant message. */
export function historyDuration(turn: Turn): number | undefined {
    const start = turn.user?.created_at;
    if (!start) return undefined;
    let end: number | undefined;
    // The finish time of the last message: a reply's created_at is when it started, so it would cut long replies short.
    for (const it of turn.items) if (it.type === "message") end = it.completed_at ?? it.created_at ?? end;
    return end && end >= start ? end - start : undefined;
}

export function parseArgs(args: string): Record<string, unknown> | undefined {
    try {
        const v: unknown = JSON.parse(args);
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

const SUMMARY_KEYS = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "glob", "name"];

/** One-line summary of tool arguments, e.g. the bash command. Partial (streaming) JSON gives "". */
export function argSummary(args: string): string {
    const a = parseArgs(args);
    if (!a) return "";
    for (const k of SUMMARY_KEYS) {
        const v = a[k];
        if (typeof v === "string" && v) return v.split("\n")[0]!;
    }
    for (const v of Object.values(a)) if (typeof v === "string" && v) return v.split("\n")[0]!;
    return Object.keys(a).length ? JSON.stringify(a) : "";
}

export type ToolKind = "terminal" | "edit" | "read" | "search" | "web" | "other";

export function toolKind(name: string): ToolKind {
    const n = name.toLowerCase();
    if (/bash|shell|exec|command|terminal|run/.test(n)) return "terminal";
    if (/edit|write|patch|create|apply/.test(n)) return "edit";
    if (/read|cat|view|open|ls|list/.test(n)) return "read";
    if (/grep|glob|find|search/.test(n)) return "search";
    if (/web|fetch|http|browse|url/.test(n)) return "web";
    return "other";
}

/** "Today 12:09 AM", "Yesterday 3:04 PM", "Oct 9 3:04 PM" (A.7 turn separator). */
export function formatStamp(ms: number): { day: string; time: string } {
    const d = new Date(ms);
    const now = new Date();
    const { locale } = activeLocalization();
    const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (days === 0) return { day: translate("thread-day-today"), time };
    if (days === 1) return { day: translate("thread-day-yesterday"), time };
    const day = d.toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
    return { day, time };
}

export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
