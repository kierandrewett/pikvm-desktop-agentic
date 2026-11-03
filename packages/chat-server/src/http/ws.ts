/**
 * The chat WebSocket: Responses-style client events in, Responses-style server events out. The host authorises the
 * upgrade (its gate and an Origin check) before it hands the socket to `acceptSocket`.
 */
import { thinkingSelectors, type ClientEvent, type InputItem, type ResponseCreateEvent } from "@pikvm/chat-protocol";
import { readFile } from "node:fs/promises";
import type { RawData } from "ws";
import { z } from "zod";
import {
    AgentBusyError,
    answerApproval,
    answerElicitation,
    answerQuestion,
    cancel,
    latestRun,
    prompt,
    release,
    queuedPosition,
    reserve,
    type Permission,
    type StartTicket,
} from "../agent/sessions.ts";
import { userDisconnected } from "../agent/slots.ts";
import { RuntimeError } from "../agent/launch.ts";
import { blockedRuntimeCommand } from "../agent/commands.ts";
import { createConversation, getConversation, NotFoundError, toSummary } from "../conversations/service.ts";
import { beginEdit, BranchError, settleEdit, type EditStart } from "../conversations/branching.ts";
import { isModelAllowed } from "../models/policy.ts";
import { setting } from "../settings/store.ts";
import { cachedMcp } from "../agent/mcp-catalog.ts";
import { writeAgentConfig } from "../agent/config.ts";
import { agentBaseUrl } from "../env.ts";
import { getUpload, StorageError, uploadFile, type UploadRow } from "../storage/uploads.ts";
import { turnModelFeatures } from "../models/features.ts";
import { addSocket, broadcast, hasSockets, removeSocket, sendTo, type ChatSocket } from "./hub.ts";
import { OPERATOR_ID } from "../paths.ts";

const ClientEventSchema = z.object({ type: z.string() }).passthrough();
const STREAM_ID = /^[A-Za-z0-9_.-]{1,256}$/;

function sendError(ws: ChatSocket, status: number, code: string, message: string, param?: string) {
    sendTo(ws, {
        type: "error",
        status,
        error: {
            type: status >= 500 ? "server_error" : "invalid_request_error",
            code,
            message,
            ...(param ? { param } : {}),
        },
    });
}

/** `@server` or `@server/tool` mentions of MCP servers get a short hint so the agent knows what the user means. */
function mcpMentionHint(userId: string, text: string): string {
    const names = new Set(Object.keys(writeAgentConfig(userId, agentBaseUrl()).mcp.mcpServers));
    const catalog = cachedMcp(userId);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_.-]+))?/g)) {
        const [, server, tool] = m;
        if (!server || !names.has(server) || seen.has(`${server}/${tool ?? ""}`)) continue;
        seen.add(`${server}/${tool ?? ""}`);
        const t =
            tool &&
            catalog
                .find((s) => s.name === server)
                ?.tools.find((x) => x.label.endsWith(`/${tool}`) || x.name.endsWith(`_${tool}`));
        lines.push(
            t
                ? `- @${server}/${tool}: use the MCP tool ${t.name}`
                : `- @${server}: use tools from the MCP server "${server}" (tools named mcp__${server}_*)`,
        );
    }
    // "mcp://<server>/<uri>" chips: a resource the user picked from that server's list.
    for (const m of text.matchAll(/(?:^|\s)mcp:\/\/([A-Za-z0-9_-]+)\/(\S+)/g)) {
        const [, server, uri] = m;
        if (!server || !uri || !names.has(server) || seen.has(`mcp://${server}/${uri}`)) continue;
        seen.add(`mcp://${server}/${uri}`);
        lines.push(`- mcp://${server}/${uri}: the user attached the MCP resource ${uri} from the server "${server}"`);
    }
    return lines.length ? `\n\n[Mentioned tools]\n${lines.join("\n")}` : "";
}

/**
 * The attachment list appended to the user's text: each upload's /uploads path. history.ts splitUserText reads the
 * "- /uploads/..." lines back, so the thread shows the attachments again. The agent cannot read the path: it has no
 * file tool, and an image reaches it as image content.
 */
function attachedFilesNote(files: UploadRow[], markers: ReadonlyMap<string, string>): string {
    if (!files.length) return "";
    const lines = files.map((r) => {
        const marker = markers.get(r.id);
        return `- /uploads/${r.id}/${r.name}` + (marker ? `\n  (the message refers to this file as ${marker})` : "");
    });
    return `\n\nAttached files:\n${lines.join("\n")}`;
}

/** Composer chip labels such as "[Pasted text #1]". Anything else is dropped, so a marker cannot carry instructions. */
const MARKER = /^\[[A-Za-z][A-Za-z ]{0,23} #\d{1,4}\]$/;
const validMarker = (m: string | undefined): m is string => !!m && MARKER.test(m);

/** Which image of the message each marker stands for. Uploaded images and files are named by their path instead. */
function markedImagesNote(markers: { marker: string; index: number }[]): string {
    if (!markers.length) return "";
    return `\n\n[Marked images]\n${markers.map((m) => `- ${m.marker}: image ${m.index} of the images attached to this message`).join("\n")}`;
}

function normaliseInput(input: ResponseCreateEvent["input"]): InputItem[] {
    if (typeof input === "string")
        return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
    return input;
}

async function handleCreate(ws: ChatSocket, e: ResponseCreateEvent): Promise<void> {
    const userId = ws.data.userId;
    if (e.stream_id !== undefined && !STREAM_ID.test(e.stream_id)) {
        return sendError(ws, 400, "invalid_stream_id", "stream_id must be 1-256 of [A-Za-z0-9_.-]", "stream_id");
    }
    const input = normaliseInput(e.input ?? []);
    // An edit (docs/spec/thread-branching.md section 6) names a stored user message of an existing chat.
    const editOf = e.metadata?.edit_of;
    if (editOf !== undefined) {
        if (typeof editOf !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(editOf))
            return sendError(ws, 400, "invalid_edit", "edit_of must be a message id", "metadata.edit_of");
        if (!e.conversation)
            return sendError(ws, 400, "missing_conversation", "conversation is required", "conversation");
    }

    // Approval answers only: route to the waiting run.
    const approvals = input.filter((i) => i.type === "mcp_approval_response");
    if (approvals.length && approvals.length === input.length) {
        if (!e.conversation)
            return sendError(ws, 400, "missing_conversation", "conversation is required", "conversation");
        for (const a of approvals) {
            if (!answerApproval(userId, e.conversation, a.approval_request_id, a.approve)) {
                sendError(ws, 404, "approval_not_found", `No pending approval ${a.approval_request_id}`);
            }
        }
        return;
    }

    // MCP elicitation answers only: route to the waiting run (src/mcp/interactions.ts).
    const elicits = input.filter((i) => i.type === "chat.mcp_elicitation_response");
    if (elicits.length && elicits.length === input.length) {
        if (!e.conversation)
            return sendError(ws, 400, "missing_conversation", "conversation is required", "conversation");
        for (const a of elicits) {
            if (!answerElicitation(userId, e.conversation, a))
                sendError(ws, 404, "elicitation_not_found", `No open request ${a.elicitation_id}`);
        }
        return;
    }

    // Question answers only: route to the waiting run.
    const asks = input.filter((i) => i.type === "chat.ask_response");
    if (asks.length && asks.length === input.length) {
        if (!e.conversation)
            return sendError(ws, 400, "missing_conversation", "conversation is required", "conversation");
        for (const a of asks) {
            const ok = answerQuestion(userId, e.conversation, a);
            if (ok === false) sendError(ws, 404, "question_not_found", `No open question ${a.ask_request_id}`);
            else if (ok === undefined)
                sendError(ws, 400, "invalid_answer", `The answer does not fit question ${a.ask_request_id}`, "input");
        }
        return;
    }

    const messages = input.filter((i) => i.type === "message");
    let text = "";
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    const files: UploadRow[] = [];
    const fileMarkers = new Map<string, string>();
    const imageMarkers: { marker: string; index: number }[] = [];
    try {
        for (const m of messages) {
            for (const part of m.content) {
                if (part.type === "input_text") text += (text ? "\n\n" : "") + part.text;
                else if (part.type === "input_image" && part.upload_id) {
                    // Images go to the model as image content.
                    const row = getUpload(userId, part.upload_id);
                    const data = (await readFile(uploadFile(userId, row))).toString("base64");
                    images.push({ type: "image", mimeType: row.mime, data });
                    files.push(row);
                    if (validMarker(part.marker)) fileMarkers.set(row.id, part.marker);
                } else if (part.type === "input_image") {
                    const match = part.image_url.match(/^data:([^;]+);base64,(.*)$/);
                    if (match) {
                        images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
                        if (validMarker(part.marker)) imageMarkers.push({ marker: part.marker, index: images.length });
                    }
                } else if (part.type === "input_file") {
                    // The agent has no tool that reads a file, so a file would only be named, never read.
                    return sendError(ws, 400, "files_not_supported", "The agent can only be sent images", "input");
                }
            }
        }
    } catch (err) {
        if (err instanceof StorageError) return sendError(ws, err.status, err.code, err.message, "input");
        throw err;
    }
    // The attachment list is added once the conversation (and so its folder) is known; it must come
    // before the mention hint, which history.ts splitUserText cuts off first.
    const hint = mcpMentionHint(userId, text);
    if (!text.trim() && !images.length && !files.length)
        return sendError(ws, 400, "empty_input", "input must contain a message", "input");
    // Runtime commands that bypass Chat's settings (agent/commands.ts).
    const blocked = blockedRuntimeCommand(text);
    if (blocked) return sendError(ws, 400, "command_not_available", `/${blocked} is not available here`, "input");

    const model = e.model || undefined;
    if (model && !isModelAllowed(userId, model)) {
        return sendError(ws, 403, "model_not_allowed", `The model ${model} is not available`, "model");
    }
    const permission: Permission = e.metadata?.permission ?? setting("agent.permission", userId);
    // Model features gate what this turn may use (models/features.ts). Reactions are applied below.
    const features = turnModelFeatures(userId, model, e.conversation);
    const effort = e.reasoning?.effort;
    // The effort reaches the runtime's command line and RPC; refuse anything that is not one of its selectors.
    if (effort !== undefined && !(thinkingSelectors as readonly string[]).includes(effort))
        return sendError(ws, 400, "invalid_effort", `Unknown reasoning effort ${String(effort)}`, "reasoning.effort");
    const thinking = features.thinkingEffort.enabled ? effort : undefined;

    let conversationId = e.conversation;
    // Held from before the first await, so a stop sent while the agent starts finds the response.
    let ticket: StartTicket | undefined;
    let edit: EditStart | undefined;
    let started = false;
    try {
        if (conversationId) {
            const row = getConversation(userId, conversationId);
            ticket = reserve(userId, row.id);
            if (editOf) edit = await beginEdit(userId, row.id, editOf);
        } else {
            const row = createConversation(userId, {
                model: model ?? setting("agent.defaultModel", userId),
                thinking: thinking ?? setting("agent.defaultThinking", userId),
            });
            conversationId = row.id;
            ticket = reserve(userId, row.id);
            broadcast(userId, {
                type: "chat.conversation.created",
                conversation: toSummary(row, true),
                client_conversation_id: e.metadata?.client_conversation_id,
            });
        }
        const run = await prompt({
            userId,
            conversationId,
            message:
                text +
                attachedFilesNote(files, fileMarkers) +
                markedImagesNote(imageMarkers) +
                hint,
            images,
            model,
            thinking,
            permission,
            streamId: e.stream_id,
            ticket,
        });
        started = true;
        // An edit whose prompt never reached the session file goes back to the old path.
        if (edit) void run.finished.then(() => settleEdit(userId, edit!));
    } catch (err) {
        if (err instanceof AgentBusyError) return sendError(ws, 409, err.code, err.message);
        if (err instanceof BranchError) return sendError(ws, err.status, err.code, err.message, "metadata.edit_of");
        if (err instanceof NotFoundError)
            return sendError(ws, 404, "conversation_not_found", err.message, "conversation");
        if (err instanceof RuntimeError) return sendError(ws, 503, "runtime_unavailable", err.message);
        console.error("[ws] response.create failed", err);
        return sendError(ws, 500, "server_error", (err as Error).message);
    } finally {
        if (ticket) release(ticket);
        // After the release: settling holds the chat itself.
        if (edit && !started) void settleEdit(userId, edit);
    }
}

async function handle(ws: ChatSocket, raw: string): Promise<void> {
    let parsed: ClientEvent;
    try {
        parsed = ClientEventSchema.parse(JSON.parse(raw)) as unknown as ClientEvent;
    } catch {
        return sendError(ws, 400, "invalid_json", "Event must be a JSON object with a type");
    }
    switch (parsed.type) {
        case "response.create":
            return handleCreate(ws, parsed);
        case "response.cancel": {
            const conv = parsed.conversation;
            if (!conv) return sendError(ws, 400, "missing_conversation", "conversation is required", "conversation");
            if (!cancel(ws.data.userId, conv, parsed.response_id))
                sendError(ws, 404, "no_active_response", "Nothing is running");
            return;
        }
        case "chat.resume": {
            try {
                getConversation(ws.data.userId, parsed.conversation);
            } catch {
                return sendError(ws, 404, "conversation_not_found", "Conversation not found");
            }
            // Running: its live state. Finished while this client was away: its terminal event, so the
            // client stops showing it as running.
            const run = latestRun(ws.data.userId, parsed.conversation);
            if (run) sendTo(ws, run.current());
            // Queued for a slot: there is no run yet, so say where it stands.
            const position = queuedPosition(ws.data.userId, parsed.conversation);
            if (position) sendTo(ws, { type: "chat.queue", conversation_id: parsed.conversation, position });
            return;
        }
        default:
            return sendError(
                ws,
                400,
                "unknown_event",
                `Unknown event type ${(parsed as { type: string }).type}`,
                "type",
            );
    }
}

const PING_MS = 30_000;

/**
 * Take over an upgraded socket: the host has already authorised it. Registers it with the hub, answers client events
 * and drops it when it stops answering pings.
 */
export function acceptSocket(sock: import("ws").WebSocket): void {
    const ws = Object.assign(sock, { data: { userId: OPERATOR_ID } }) as ChatSocket;
    let alive = true;
    ws.on("pong", () => {
        alive = true;
    });
    const ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
    }, PING_MS);
    ping.unref();
    ws.on("close", () => {
        clearInterval(ping);
        removeSocket(ws);
        userDisconnected(ws.data.userId, () => hasSockets(ws.data.userId));
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", (msg: RawData) => {
        // Every client event gets an answer: an unexpected throw becomes an error event, not silence.
        handle(ws, msg.toString()).catch((err: Error) => {
            console.error("[ws] event failed", err);
            if (ws.readyState === ws.OPEN) sendError(ws, 500, "server_error", err.message);
        });
    });
    addSocket(ws);
}
