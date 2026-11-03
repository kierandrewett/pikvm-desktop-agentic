/**
 * Fork, rewind and message versions: new branches of a conversation's session tree
 * (docs/spec/thread-branching.md).
 *
 * The session JSONL is a tree (id/parentId) and the runtime loads the last entry in file order as the
 * active leaf. Both operations use the runtime's own file format and rules, applied by the server while no
 * agent process holds the file:
 *
 * - Rewind appends one `branch_summary` entry with an empty summary whose parent is the cut. This is how the
 *   runtime itself moves the leaf durably (SessionManager.branchWithSummary, discardEntryDurably): the entry
 *   becomes the leaf, the old branch stays in the file, and an empty summary adds nothing to the model's
 *   context. Undo appends another such entry whose parent is the old leaf. The runtime's RPC `branch` command
 *   is not used: it writes a new session file without the session's artifacts directory, where the subagent
 *   transcripts of the kept turns live.
 * - Fork writes a new session file for a new conversation, as SessionManager.createBranchedSession does for
 *   the runtime's own `fork`: a title slot and header with a fresh session id, the root-to-cut path without
 *   label entries (byte-for-byte copies of the source lines), the labels in effect recreated after it, and a
 *   copy of the artifacts directory. The runtime's RPC `fork` is not used: it writes into the source
 *   conversation's directory and moves the source's live process onto the new file.
 *
 * - Edit (section 6 of the spec) appends a `chat-edit` marker whose parent is the edited message's parent, then
 *   the prompt writes the new version under it. A version switch appends a `chat-switch` marker at the chosen
 *   version's leaf. Versions themselves are computed in versions.ts. If an edit's prompt never reaches the file,
 *   a `chat-edit-revert` marker returns to the old path.
 *
 * Cut points come from history item ids (`<entryId>` or `<entryId>.<n>`, see history.ts). A user message
 * cuts just before it and returns its text for the composer, as the runtime's branch does; any other item
 * cuts at the end of its turn, so a fork never ends on a tool call whose result exists in the source.
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "../ids.ts";
import { AgentBusyError, agentCwd, isActive, stopIdleProcess, withSessionHeld } from "../agent/sessions.ts";
import { paths } from "../paths.ts";
import { copyFrames } from "../storage/frames.ts";
import { forgetSession, readSessionItems, splitUserText } from "./history.ts";
import {
    createConversation,
    deleteConversation,
    getConversation,
    sessionFilePath,
    NotFoundError,
    toSummary,
    updateConversation,
    type ConversationRow,
} from "./service.ts";
import { snippetOf } from "./snippet.ts";
import { indexVersions, isUserMessage, type MarkerKind, type TreeEntry } from "./versions.ts";

export class BranchError extends Error {
    constructor(
        readonly status: 400 | 404 | 409,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

interface RawEntry extends TreeEntry {
    id: string;
    message?: { role?: string; content?: string | { type: string; text?: string }[] };
    targetId?: string;
    label?: string;
}

interface Line {
    /** The line as it is in the file, without its newline. Kept entries are copied with these bytes. */
    raw: string;
    e: RawEntry;
}

interface Tree {
    text: string;
    title?: { title?: string; source?: "auto" | "user" };
    header?: { version?: number; additionalDirectories?: string[] };
    /** Entries in file order. */
    lines: Line[];
    byId: Map<string, Line>;
    /** The active leaf: the last entry in file order, as the runtime and history.ts read it. */
    leaf: string | null;
}

/** Parse a session file leniently (a torn last line is skipped, as history.ts does). */
function readTree(text: string): Tree {
    const tree: Tree = { text, lines: [], byId: new Map(), leaf: null };
    for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        let e: RawEntry;
        try {
            e = JSON.parse(raw);
        } catch {
            continue;
        }
        if (e?.type === "title") tree.title ??= e as Tree["title"];
        else if (e?.type === "session") tree.header ??= e as Tree["header"];
        else if (typeof e?.id === "string") {
            const line = { raw, e };
            tree.lines.push(line);
            tree.byId.set(e.id, line);
            tree.leaf = e.id;
        }
    }
    return tree;
}

/** Root-to-leaf entries of a branch. */
function pathTo(tree: Tree, leaf: string | null): Line[] {
    const out: Line[] = [];
    const seen = new Set<string>();
    for (let l = leaf ? tree.byId.get(leaf) : undefined; l && !seen.has(l.e.id);) {
        seen.add(l.e.id);
        out.push(l);
        l = l.e.parentId ? tree.byId.get(l.e.parentId) : undefined;
    }
    return out.reverse();
}

function userText(e: RawEntry): string {
    const c = e.message?.content;
    const raw = typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    return splitUserText(raw).text;
}

interface Cut {
    /** The entry the branch ends at; null for an empty branch (cut before the first message). */
    leaf: string | null;
    draft?: string;
}

/** Where a fork or rewind at history item `itemId` cuts the active branch. */
function cutAt(tree: Tree, itemId: string): Cut {
    const entryId = itemId.split(".")[0]!;
    const path = pathTo(tree, tree.leaf);
    const at = path.findIndex((l) => l.e.id === entryId);
    if (at < 0) throw new BranchError(404, "not_found", "That message is not in this chat's history.");
    const target = path[at]!.e;
    if (isUserMessage(target)) return { leaf: target.parentId ?? null, draft: userText(target) };
    let end = at;
    while (end + 1 < path.length && !isUserMessage(path[end + 1]!.e)) end++;
    return { leaf: path[end]!.e.id };
}

/** A fresh entry id, as the runtime makes them (generateId: the last 8 characters of a UUID). */
function newEntryId(taken: { has(id: string): boolean }): string {
    for (;;) {
        const id = crypto.randomUUID().slice(-8);
        if (!taken.has(id)) return id;
    }
}

function readSession(userId: string, row: ConversationRow): { file: string; tree: Tree } | undefined {
    const file = sessionFilePath(userId, row);
    if (!file || !existsSync(file)) return undefined;
    const tree = readTree(readFileSync(file, "utf8"));
    return tree.leaf ? { file, tree } : undefined;
}

/** Append a leaf-moving marker (an empty `branch_summary`, as SessionManager.branchWithSummary writes it). */
function appendMarker(
    file: string,
    tree: Tree,
    parentId: string | null,
    details: { kind: MarkerKind } & Record<string, unknown>,
): string {
    const id = newEntryId(tree.byId);
    const entry = {
        type: "branch_summary",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        fromId: parentId ?? "root",
        summary: "",
        details,
    };
    // A file the runtime left without a final newline (a torn write) must not swallow the marker.
    const sep = tree.text === "" || tree.text.endsWith("\n") ? "" : "\n";
    appendFileSync(file, `${sep}${JSON.stringify(entry)}\n`);
    forgetSession(file);
    return id;
}

const busy = () =>
    new BranchError(409, "conversation_busy", "Wait for the response to finish, or stop it, then try again.");

/** Set the sidebar snippet from the new active path (snippet.ts), or clear it when that path has no answer. */
async function refreshSnippet(userId: string, conversationId: string, file: string): Promise<void> {
    const snippet = snippetOf(await readSessionItems(file, conversationId)) ?? "";
    updateConversation(userId, conversationId, { snippet });
}

export interface RewindResult {
    conversation: ConversationSummary;
    leaf: string;
    previousLeaf: string;
    draft?: string;
}

/**
 * Discard everything after the cut at `itemId`: the active branch ends there, the old branch stays in the
 * file for Undo. Refused while a response runs (the live process is stopped first, see withSessionHeld).
 */
export async function rewindConversation(
    userId: string,
    conversationId: string,
    itemId: string,
): Promise<RewindResult> {
    getConversation(userId, conversationId);
    if (isActive(conversationId)) throw busy();
    return withSessionHeld(userId, conversationId, async () => {
        const session = readSession(userId, getConversation(userId, conversationId));
        if (!session) throw new BranchError(409, "nothing_to_rewind", "This chat has no messages yet.");
        const { file, tree } = session;
        const previousLeaf = tree.leaf!;
        const cut = cutAt(tree, itemId);
        if (cut.leaf === previousLeaf)
            throw new BranchError(409, "nothing_to_rewind", "There is nothing after this message.");
        const leaf = appendMarker(file, tree, cut.leaf, { kind: "chat-rewind", previousLeafId: previousLeaf });
        console.log(`[branch] ${conversationId}: rewound to ${cut.leaf ?? "root"} (was ${previousLeaf})`);
        await refreshSnippet(userId, conversationId, file);
        const conversation = toSummary(getConversation(userId, conversationId));
        return { conversation, leaf, previousLeaf, ...(cut.draft !== undefined ? { draft: cut.draft } : {}) };
    });
}

/** Return to the branch a rewind left, unless the chat moved on since (then the active leaf is not `leaf`). */
export async function undoRewind(
    userId: string,
    conversationId: string,
    leaf: string,
    previousLeaf: string,
): Promise<{ conversation: ConversationSummary; leaf: string }> {
    getConversation(userId, conversationId);
    if (isActive(conversationId)) throw busy();
    return withSessionHeld(userId, conversationId, async () => {
        const session = readSession(userId, getConversation(userId, conversationId));
        if (!session || session.tree.leaf !== leaf)
            throw new BranchError(409, "changed", "The chat changed after the rewind, so it was left as it is.");
        if (!session.tree.byId.has(previousLeaf))
            throw new BranchError(404, "not_found", "The earlier messages are no longer in this chat.");
        const next = appendMarker(session.file, session.tree, previousLeaf, {
            kind: "chat-rewind-undo",
            rewindLeafId: leaf,
        });
        console.log(`[branch] ${conversationId}: undid rewind, back to ${previousLeaf}`);
        await refreshSnippet(userId, conversationId, session.file);
        return { conversation: toSummary(getConversation(userId, conversationId)), leaf: next };
    });
}

/** An edit in progress: the marker the new version goes under, and the leaf to return to if it never lands. */
export interface EditStart {
    conversationId: string;
    marker: string;
    previousLeaf: string;
}

/**
 * Start an edit of user message `itemId` (a new version of it). The caller holds the conversation (ws.ts
 * `reserve`), so no response runs. The idle process is stopped first: it keeps the tree in memory and would go on
 * from its old leaf. Then a `chat-edit` marker whose parent is the message's parent becomes the leaf, and the
 * prompt that follows writes the new version under it. Call `settleEdit` when that response ends.
 */
export async function beginEdit(userId: string, conversationId: string, itemId: string): Promise<EditStart> {
    const row = getConversation(userId, conversationId);
    const find = () => {
        const session = readSession(userId, row);
        const target = session && pathTo(session.tree, session.tree.leaf).find((l) => l.e.id === itemId)?.e;
        if (!session || !target) throw new BranchError(404, "not_found", "That message is not in this chat's history.");
        if (!isUserMessage(target))
            throw new BranchError(400, "not_a_user_message", "Only your own messages can be edited.");
        return { session, target };
    };
    // Checked before and after the stop: a refused edit leaves the process running, and the stopped process may
    // write its own last lines.
    find();
    await stopIdleProcess(conversationId);
    const { session, target } = find();
    const previousLeaf = session.tree.leaf!;
    const marker = appendMarker(session.file, session.tree, target.parentId ?? null, {
        kind: "chat-edit",
        editedEntryId: target.id,
        previousLeafId: previousLeaf,
    });
    console.log(`[branch] ${conversationId}: editing ${target.id} (was ${previousLeaf})`);
    return { conversationId, marker, previousLeaf };
}

/**
 * After an edit's response: if the prompt never reached the file (stopped while starting, refused, the process
 * died), the leaf is still the edit marker and the chat would show nothing from the edited message on. Then a
 * `chat-edit-revert` marker returns to the old path. A response that wrote the new version changes nothing here.
 */
export async function settleEdit(userId: string, edit: EditStart): Promise<void> {
    const { conversationId, marker, previousLeaf } = edit;
    // Not sent: the active path still runs through the marker and has no user message after it. A new process
    // may have written its own metadata entries after the marker, so the leaf alone does not tell.
    const unsent = (tree: Tree) => {
        const path = pathTo(tree, tree.leaf);
        const at = path.findIndex((l) => l.e.id === marker);
        return at >= 0 && !path.slice(at + 1).some((l) => isUserMessage(l.e));
    };
    const session = () => readSession(userId, getConversation(userId, conversationId));
    try {
        // Checked before the hold, so a normal edit does not stop the process it just used.
        const before = session();
        if (!before || !unsent(before.tree)) return;
        await withSessionHeld(userId, conversationId, async () => {
            const now = session();
            if (!now || !unsent(now.tree)) return;
            const { file, tree } = now;
            appendMarker(file, tree, previousLeaf, { kind: "chat-edit-revert", editMarkerId: marker });
            console.log(`[branch] ${conversationId}: edit was not sent, back to ${previousLeaf}`);
        });
    } catch (err) {
        // A deleted chat needs nothing; a new response holds the chat and goes on from the edit marker.
        if (err instanceof NotFoundError || err instanceof AgentBusyError) return;
        console.error(`[branch] ${conversationId}: could not settle the edit`, err);
    }
}

/**
 * Make version `itemId` of a user message on the active path active: a `chat-switch` marker at the place that
 * version was last left (versions.ts `leafFor`). The next process loads that path, so the next turn's context
 * follows it. Refused while a response runs.
 */
export async function switchVersion(
    userId: string,
    conversationId: string,
    itemId: string,
): Promise<{ conversation: ConversationSummary; leaf: string }> {
    getConversation(userId, conversationId);
    if (isActive(conversationId)) throw busy();
    return withSessionHeld(userId, conversationId, async () => {
        const session = readSession(userId, getConversation(userId, conversationId));
        const notFound = () => new BranchError(404, "not_found", "That version is not in this chat.");
        if (!session) throw notFound();
        const { file, tree } = session;
        const path = pathTo(tree, tree.leaf);
        const chosen = tree.byId.get(itemId)?.e;
        if (!chosen || !isUserMessage(chosen)) throw notFound();
        if (path.some((l) => l.e.id === itemId))
            return { conversation: toSummary(getConversation(userId, conversationId)), leaf: tree.leaf! };
        const index = indexVersions(tree.lines.map((l) => l.e));
        const isVersion = path.some((l) => isUserMessage(l.e) && index.group(l.e.id)?.includes(itemId));
        if (!isVersion) throw notFound();
        const leaf = appendMarker(file, tree, index.leafFor(itemId), { kind: "chat-switch", versionId: itemId });
        console.log(`[branch] ${conversationId}: switched to version ${itemId}`);
        await refreshSnippet(userId, conversationId, file);
        return { conversation: toSummary(getConversation(userId, conversationId)), leaf };
    });
}

const TITLE_SLOT_BYTES = 256;

/**
 * The fixed-width first line the runtime keeps the title in (session-title-slot.ts serializeTitleSlot):
 * exactly 256 UTF-8 bytes with its newline, the title cut by code points to fit, the rest `pad` spaces.
 */
function titleSlot(title: string, source: "auto" | "user" | undefined, updatedAt: string): string {
    const line = (t: string, pad: string) =>
        `${JSON.stringify(source ? { type: "title", v: 1, title: t, source, updatedAt, pad } : { type: "title", v: 1, title: t, updatedAt, pad })}\n`;
    const points = [...title];
    let low = 0;
    let high = points.length;
    let best = "";
    while (low <= high) {
        const mid = (low + high) >>> 1;
        const candidate = points.slice(0, mid).join("");
        if (Buffer.byteLength(line(candidate, "")) <= TITLE_SLOT_BYTES) {
            best = candidate;
            low = mid + 1;
        } else high = mid - 1;
    }
    return line(best, " ".repeat(TITLE_SLOT_BYTES - Buffer.byteLength(line(best, ""))));
}

/** The new session file's text: what SessionManager.createBranchedSession writes for the root-to-`leaf` path. */
function forkBody(
    tree: Tree,
    leaf: string,
    o: { sessionId: string; timestamp: string; cwd: string; title: string; parentSession: string },
): string {
    const kept = pathTo(tree, leaf).filter((l) => l.e.type !== "label");
    const keptIds = new Set(kept.map((l) => l.e.id));
    // Labels in effect (the newest label entry per target wins; an empty one removes it), for kept targets only.
    const labels = new Map<string, string>();
    for (const { e } of tree.lines) {
        if (e.type !== "label" || !e.targetId) continue;
        if (e.label) labels.set(e.targetId, e.label);
        else labels.delete(e.targetId);
    }
    const out = [titleSlot(o.title, o.title ? "auto" : undefined, o.timestamp)];
    const header = {
        type: "session",
        version: tree.header?.version ?? 3,
        id: o.sessionId,
        timestamp: o.timestamp,
        cwd: o.cwd,
        title: o.title || undefined,
        titleSource: o.title ? "auto" : undefined,
        parentSession: o.parentSession,
        additionalDirectories: tree.header?.additionalDirectories?.length
            ? tree.header.additionalDirectories
            : undefined,
    };
    out.push(`${JSON.stringify(header)}\n`);
    for (const l of kept) out.push(`${l.raw}\n`);
    let parentId = kept.at(-1)?.e.id ?? null;
    const taken = new Set(keptIds);
    for (const [targetId, label] of labels) {
        if (!keptIds.has(targetId)) continue;
        const id = newEntryId(taken);
        taken.add(id);
        out.push(`${JSON.stringify({ type: "label", id, parentId, timestamp: o.timestamp, targetId, label })}\n`);
        parentId = id;
    }
    return out.join("");
}

/**
 * Copies keep symlinks as they are: attachment links (storage/attachments.ts) are relative, so they resolve the
 * same from the fork's folder (same depth). Resolving them would write host paths.
 */
const COPY = { recursive: true, verbatimSymlinks: true } as const;

/**
 * A new conversation with the source's history up to the cut at `itemId` (the whole active branch without
 * it), the same model and reasoning effort, and a copy of the chat's workspace folder. The
 * source is only read.
 */
export async function forkConversation(
    userId: string,
    sourceId: string,
    itemId?: string,
): Promise<{ row: ConversationRow; draft?: string }> {
    const src = getConversation(userId, sourceId);
    if (isActive(sourceId)) throw busy();
    const session = readSession(userId, src);
    if (!session) throw new BranchError(409, "empty_chat", "This chat has no messages to fork yet.");
    const { file, tree } = session;
    const cut = itemId ? cutAt(tree, itemId) : { leaf: tree.leaf };

    const u = paths.user(userId);
    const artifacts = file.replace(/\.jsonl$/, "");
    const workspace = u.chatWorkspace(src.id);

    const title = src.title ? `${src.title} (fork)` : "";
    const row = createConversation(userId, {
        model: src.model,
        thinking: src.thinking,
        title: title || undefined,
        fork: { from: src.id },
    });
    try {
        mkdirSync(u.conversation(row.id), { recursive: true });
        let sessionFile: string | undefined;
        if (cut.leaf) {
            const timestamp = new Date().toISOString();
            const sessionId = uuidv7();
            sessionFile = `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
            const out = join(u.conversation(row.id), sessionFile);
            const body = forkBody(tree, cut.leaf, {
                sessionId,
                timestamp,
                cwd: agentCwd(userId, row),
                title,
                parentSession: join(u.conversation(src.id), src.sessionFile!),
            });
            writeFileSync(out, body, { flag: "wx" });
            if (existsSync(artifacts)) cpSync(artifacts, out.replace(/\.jsonl$/, ""), COPY);
        }
        if (existsSync(workspace)) cpSync(workspace, u.chatWorkspace(row.id), COPY);
        // The fork's history names the same frames as the chat it came from.
        copyFrames(userId, src.id, row.id);
        const done = sessionFile ? updateConversation(userId, row.id, { sessionFile }) : row;
        console.log(`[branch] forked ${sourceId} at ${cut.leaf ?? "root"} into ${row.id}`);
        return { row: done, ...(cut.draft !== undefined ? { draft: cut.draft } : {}) };
    } catch (err) {
        // No half-made fork is left behind.
        deleteConversation(userId, row.id);
        throw err;
    }
}
