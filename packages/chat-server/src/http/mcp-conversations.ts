/**
 * MCP server exposing the user's own conversations to their agent (`agent.conversationsTool`).
 *
 * The HTTP shell (stateless streamable HTTP, gateway token, `X-Chat-Conversation`) is `serveMcp` in
 * http/mcp-rpc.ts. Every tool works on the token user's own conversations only; a conversation id that belongs to
 * someone else answers "Conversation not found", the same as an id that does not exist.
 *
 * One tool writes: `rename_conversation`. It goes through `updateConversation`, so a title set here gets
 * `titleSource: "user"` and the automatic title (titles.ts, the runtime's own title sync in agent/sessions.ts) never
 * overwrites it. It broadcasts `chat.conversation.updated`, so open tabs update live. Without `id` it acts on the
 * calling conversation.
 */
import type { AgenticChange, OutputItem } from "@pikvm/chat-protocol";
import { isActive } from "../agent/sessions.ts";
import {
    getConversation,
    listConversations,
    sessionFilePath,
    toSummary,
    updateConversation,
} from "../conversations/service.ts";
import { readSessionItems } from "../conversations/history.ts";
import { cleanTitle } from "../conversations/titles.ts";
import { setting } from "../settings/store.ts";
import { broadcast } from "./hub.ts";
import { MCP_PROTOCOL_VERSION, rpcError, rpcResult, serveMcp, type McpCaller, type McpRpcRequest } from "./mcp-rpc.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Writes replace a value and are safe to repeat; nothing is deleted. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const tools = [
    {
        name: "list_conversations",
        description:
            "List the user's recent conversations (newest first) with id, title and last update time.",
        annotations: READ_ONLY,
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
        },
    },
    {
        name: "search_conversations",
        description:
            "Search the user's conversations by words in the title or message text. Returns matching conversations with short snippets.",
        annotations: READ_ONLY,
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Words to look for (all must appear)" },
                limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
            required: ["query"],
        },
    },
    {
        name: "read_conversation",
        description:
            "Read the transcript of one conversation by id: user and assistant messages, with tool calls summarised.",
        annotations: READ_ONLY,
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string" },
                maxMessages: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            },
            required: ["id"],
        },
    },
    {
        name: "rename_conversation",
        description:
            "Rename one of the user's conversations. The title counts as set by the user: automatic titles never replace it. " +
            "Without id it renames the current conversation.",
        annotations: WRITE,
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", minLength: 1, maxLength: 200, description: "The new title, a few words" },
                id: { type: "string", description: "Conversation id. Default: the current conversation" },
            },
            required: ["title"],
        },
    },
];

function itemText(it: OutputItem): string | undefined {
    if (it.type === "message") {
        const text = it.content
            .map((p) => ("text" in p ? p.text : p.type === "input_file" ? `[file ${p.filename}]` : "[image]"))
            .join("\n");
        return `${it.role === "user" ? "User" : "Assistant"}: ${text}`;
    }
    if (it.type === "function_call") return `Tool call ${it.name}: ${it.arguments.slice(0, 300)}`;
    if (it.type === "function_call_output") return `Tool result: ${it.output.slice(0, 300)}`;
    return undefined;
}

async function transcript(userId: string, id: string): Promise<string[]> {
    const row = getConversation(userId, id);
    const file = sessionFilePath(userId, row);
    const items = file ? await readSessionItems(file, id) : [];
    return items.map(itemText).filter((t): t is string => !!t);
}

/** The conversation a write tool acts on: `id`, else the calling conversation. */
function targetConversation(caller: McpCaller, args: Record<string, unknown>) {
    const given = args.id;
    if (given !== undefined && typeof given !== "string") throw new Error("id must be a string");
    const id = given || caller.conversationId;
    if (!id) throw new Error("id is required: this call did not come from a conversation");
    return getConversation(caller.userId, id);
}

/** `agentic`: the fields the agent changed, so open clients animate them (the user's own edits send none). */
function publish(userId: string, id: string, agentic?: AgenticChange): void {
    broadcast(userId, {
        type: "chat.conversation.updated",
        conversation: toSummary(getConversation(userId, id), isActive(id)),
        ...(agentic ? { agentic } : {}),
    });
}

function renameConversation(caller: McpCaller, args: Record<string, unknown>): string {
    const row = targetConversation(caller, args);
    if (typeof args.title !== "string") throw new Error("title is required");
    if (args.title.length > 200) throw new Error("title must be at most 200 characters");
    const title = cleanTitle(args.title);
    if (!title) throw new Error("title must contain words");
    // A title patch stores titleSource "user" (service.ts), so automatic titles leave it alone.
    updateConversation(caller.userId, row.id, { title });
    publish(caller.userId, row.id, { title: true });
    return `Renamed the conversation to "${title}".`;
}

async function callTool(caller: McpCaller, name: string, args: Record<string, unknown>): Promise<string> {
    const { userId } = caller;
    if (name === "rename_conversation") return renameConversation(caller, args);
    if (name === "list_conversations") {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        const rows = listConversations(userId).slice(0, limit);
        return JSON.stringify(
            rows.map((r) => ({
                id: r.id,
                title: r.title || "Untitled",
                updatedAt: new Date(r.updatedAt).toISOString(),
            })),
            null,
            2,
        );
    }
    if (name === "search_conversations") {
        const words = String(args.query ?? "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        if (!words.length) throw new Error("query is required");
        const limit = Math.min(Number(args.limit ?? 10), 50);
        const hits: { id: string; title: string; snippets: string[] }[] = [];
        for (const r of listConversations(userId)) {
            if (hits.length >= limit) break;
            const lines = await transcript(userId, r.id);
            const hay = `${r.title}\n${lines.join("\n")}`.toLowerCase();
            if (!words.every((w) => hay.includes(w))) continue;
            const snippets = lines
                .filter((l) => words.some((w) => l.toLowerCase().includes(w)))
                .slice(0, 3)
                .map((l) => l.slice(0, 240));
            hits.push({ id: r.id, title: r.title || "Untitled", snippets });
        }
        return hits.length ? JSON.stringify(hits, null, 2) : "No conversations matched.";
    }
    if (name === "read_conversation") {
        const id = String(args.id ?? "");
        const row = getConversation(userId, id);
        const max = Math.min(Number(args.maxMessages ?? 100), 500);
        const lines = await transcript(userId, id);
        const shown = lines.slice(-max);
        return `# ${row.title || "Untitled"}\n\n${lines.length > shown.length ? `(${lines.length - shown.length} earlier entries omitted)\n\n` : ""}${shown.join("\n\n")}`;
    }
    throw new Error(`Unknown tool ${name}`);
}

async function handle(caller: McpCaller, msg: McpRpcRequest): Promise<unknown> {
    switch (msg.method) {
        case "initialize":
            return rpcResult(msg, {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "conversations", version: "1.0.0" },
                instructions: "Tools to look up and rename the user's conversations in this chat app.",
            });
        case "ping":
            return rpcResult(msg, {});
        case "tools/list":
            return rpcResult(msg, { tools });
        case "tools/call": {
            const p = msg.params ?? {};
            try {
                const text = await callTool(caller, String(p.name), (p.arguments as Record<string, unknown>) ?? {});
                return rpcResult(msg, { content: [{ type: "text", text }] });
            } catch (err) {
                return rpcResult(msg, { content: [{ type: "text", text: (err as Error).message }], isError: true });
            }
        }
        default:
            return rpcError(msg, -32601, `Method not found: ${msg.method}`);
    }
}

export function handleConversationsMcp(req: Request): Promise<Response> {
    return serveMcp(req, { enabled: (userId) => setting("agent.conversationsTool", userId), handle });
}
