import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { ForkResponse, RewindResponse, RewindUndoResponse, VersionSwitchResponse } from "@pikvm/chat-protocol";
import { AgentBusyError, isActive, stopConversation } from "../agent/sessions.ts";
import {
    BranchError,
    forkConversation,
    rewindConversation,
    switchVersion,
    undoRewind,
} from "../conversations/branching.ts";
import { StorageError } from "../storage/uploads.ts";
import {
    conversationItems,
    deleteConversation,
    getConversation,
    listConversations,
    NotFoundError,
    sessionFilePath,
    toSummary,
    updateConversation,
} from "../conversations/service.ts";
import { paths } from "../paths.ts";
import { subagentItems } from "../conversations/history.ts";
import { conversationMarkdown, exportFileName } from "../conversations/export.ts";
import { resolveConversationRef } from "../conversations/slug.ts";
import { body, requireUser, type Env } from "./context.ts";
import { broadcast } from "./hub.ts";

const ConversationPatch = z.object({
    title: z.string().max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    // Undo: put back the exact values a previous PATCH reported in `previous` (pin and archive times keep their
    // order in the lists; titleSource "auto" keeps the agent's own title sync on).
    pinnedAt: z.number().int().positive().nullable().optional(),
    archivedAt: z.number().int().positive().nullable().optional(),
    titleSource: z.enum(["auto", "user"]).optional(),
});

function notFound<T>(fn: () => T): T {
    try {
        return fn();
    } catch (err) {
        if (err instanceof NotFoundError) throw new HTTPException(404, { message: err.message });
        throw err;
    }
}

const ItemRef = z.string().min(1).max(200);
const EntryId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/** Fork and rewind refusals as `{ error: { code, message } }`, with the code the client can act on. */
async function branching<T>(c: Context<Env>, run: () => Promise<T>): Promise<T | Response> {
    try {
        return await run();
    } catch (err) {
        const fail = (status: number, code: string, message: string) =>
            c.json({ error: { code, message } }, status as 400);
        if (err instanceof BranchError) return fail(err.status, err.code, err.message);
        if (err instanceof AgentBusyError) return fail(409, "conversation_busy", err.message);
        if (err instanceof StorageError) return fail(err.status, err.code, err.message);
        throw err;
    }
}

export const conversationRoutes = new Hono<Env>()
    .get("/conversations", (c) => {
        const user = requireUser(c);
        const archived = c.req.query("archived") === "1";
        return c.json({ conversations: listConversations(user.id, { archived }).map((r) => toSummary(r, isActive(r.id))) });
    })
    // `/c/<ref>` from the browser URL -> the conversation (docs/spec/chat-urls.md). Before `/:id`, so
    // "resolve" is never read as an id.
    .get("/conversations/resolve/:ref", (c) => {
        const user = requireUser(c);
        const hit = resolveConversationRef(user.id, c.req.param("ref"));
        if (!hit) throw new HTTPException(404, { message: "Conversation not found" });
        const r = getConversation(user.id, hit.id);
        return c.json({ id: hit.id, path: hit.path, via: hit.via, conversation: toSummary(r, isActive(r.id)) });
    })
    .get("/conversations/:id", (c) => {
        const user = requireUser(c);
        const r = notFound(() => getConversation(user.id, c.req.param("id")));
        return c.json({ conversation: toSummary(r, isActive(r.id)) });
    })
    .get("/conversations/:id/items", async (c) => {
        const user = requireUser(c);
        const limit = c.req.query("limit");
        const page = await notFound(() =>
            conversationItems(user.id, c.req.param("id"), {
                before: c.req.query("before"),
                limit: limit ? Math.min(Number(limit), 1000) : undefined,
            }),
        );
        return c.json(page);
    })
    // The whole active branch as a Markdown download (conversations/export.ts).
    .get("/conversations/:id/export.md", async (c) => {
        const user = requireUser(c);
        const row = notFound(() => getConversation(user.id, c.req.param("id")));
        const { items } = await conversationItems(user.id, row.id);
        const name = exportFileName(row);
        return new Response(conversationMarkdown(row, items), {
            headers: {
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
                "cache-control": "no-store",
            },
        });
    })
    // A subagent's own transcript (`task` tool), as items. Read on each request: it grows while the subagent runs.
    .get("/conversations/:id/subagents/:agentId/items", (c) => {
        const user = requireUser(c);
        const row = notFound(() => getConversation(user.id, c.req.param("id")));
        const file = sessionFilePath(user.id, row);
        const items = file ? subagentItems(file.replace(/\.jsonl$/, ""), c.req.param("agentId"), row.id) : undefined;
        if (!items) throw new HTTPException(404, { message: "Subagent not found" });
        return c.json({ items, active: isActive(row.id) });
    })
    // Fork and rewind (conversations/branching.ts). Both are refused while a response runs.
    .post("/conversations/:id/fork", async (c) => {
        const user = requireUser(c);
        const { itemId } = await body(c, z.object({ itemId: ItemRef.optional() }));
        return branching(c, async () => {
            const { row, draft } = await forkConversation(user.id, c.req.param("id"), itemId);
            const conversation = toSummary(row);
            broadcast(user.id, { type: "chat.conversation.created", conversation });
            return c.json({ conversation, ...(draft !== undefined ? { draft } : {}) } satisfies ForkResponse, 201);
        });
    })
    .post("/conversations/:id/rewind", async (c) => {
        const user = requireUser(c);
        const { itemId } = await body(c, z.object({ itemId: ItemRef }));
        return branching(c, async () => {
            const r = await rewindConversation(user.id, c.req.param("id"), itemId);
            broadcast(user.id, { type: "chat.conversation.updated", conversation: r.conversation });
            return c.json(r satisfies RewindResponse);
        });
    })
    .post("/conversations/:id/rewind/undo", async (c) => {
        const user = requireUser(c);
        const { leaf, previousLeaf } = await body(c, z.object({ leaf: EntryId, previousLeaf: EntryId }));
        return branching(c, async () => {
            const r = await undoRewind(user.id, c.req.param("id"), leaf, previousLeaf);
            broadcast(user.id, { type: "chat.conversation.updated", conversation: r.conversation });
            return c.json(r satisfies RewindUndoResponse);
        });
    })
    // Make another version of an edited message active (docs/spec/thread-branching.md section 6).
    .post("/conversations/:id/versions", async (c) => {
        const user = requireUser(c);
        const { itemId } = await body(c, z.object({ itemId: EntryId }));
        return branching(c, async () => {
            const r = await switchVersion(user.id, c.req.param("id"), itemId);
            broadcast(user.id, { type: "chat.conversation.updated", conversation: r.conversation });
            return c.json(r satisfies VersionSwitchResponse);
        });
    })
    .get("/conversations/:id/blobs/:hash", async (c) => {
        const user = requireUser(c);
        notFound(() => getConversation(user.id, c.req.param("id")));
        const hash = c.req.param("hash");
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new HTTPException(400, { message: "Bad blob id" });
        const file = join(paths.user(user.id).home, ".omp", "agent", "blobs", hash);
        const found = await stat(file).catch(() => undefined);
        if (!found?.isFile()) throw new HTTPException(404, { message: "Blob not found" });
        return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "cache-control": "private, max-age=31536000, immutable" } });
    })
    .patch("/conversations/:id", async (c) => {
        const user = requireUser(c);
        const patch = await body(c, ConversationPatch);
        const id = c.req.param("id");
        const before = notFound(() => getConversation(user.id, id));
        if (Math.max(patch.pinnedAt ?? 0, patch.archivedAt ?? 0) > Date.now()) {
            throw new HTTPException(400, { message: "Pin and archive times cannot be in the future" });
        }
        const r = notFound(() => updateConversation(user.id, id, patch));
        const summary = toSummary(r, isActive(r.id));
        broadcast(user.id, { type: "chat.conversation.updated", conversation: summary });
        // The values this PATCH replaced, so the client can offer an exact Undo.
        const previous = {
            title: before.title,
            titleSource: before.titleSource,
            pinnedAt: before.pinnedAt,
            archivedAt: before.archivedAt,
            projectId: null,
        };
        return c.json({ conversation: summary, previous });
    })
    .delete("/conversations/:id", async (c) => {
        const user = requireUser(c);
        const id = c.req.param("id");
        notFound(() => getConversation(user.id, id));
        await stopConversation(id);
        deleteConversation(user.id, id);
        broadcast(user.id, { type: "chat.conversation.deleted", conversation_id: id });
        return c.json({ ok: true });
    });
