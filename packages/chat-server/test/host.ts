/**
 * A minimal host for tests and the E2E script: one HTTP listener that does what the PiKVM host does around the chat
 * server (mount the REST routes and the WebSocket under a prefix), plus a fake MCP server standing in for the PiKVM
 * one, so a run can call a tool and ask for approval without any PiKVM code.
 */
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startFakeModel, type FakeModel } from "../../../tools/fake-model/server.ts";
import { sendResponse, toRequest } from "../src/http/node-adapter.ts";
import { createChatServer, type BuiltinMcp, type ChatServer, type ChatServerOptions } from "../src/index.ts";
import { tempDir } from "./temp.ts";

export const API = "/app/chat/api";
export const WS_PATH = "/app/chat/ws";

export interface Fixture {
    chat: ChatServer;
    model: FakeModel;
    dataDir: string;
    /** `http://127.0.0.1:<port>`, the host listener. */
    origin: string;
    /** Calls the fake PiKVM server received: `{ tool, args, conversationId }`. */
    calls: { tool: string; args: unknown; conversationId: string | undefined }[];
    /** Authorization headers the fake PiKVM server received. */
    mcpAuth: (string | null)[];
    api(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
    /** Open the chat WebSocket. */
    connect(): Promise<Client>;
    /** Stop the chat server and start a new one on the same data directory (a host restart). */
    restart(): Promise<void>;
    close(): Promise<void>;
}

export interface Client {
    events: Event[];
    send(event: Record<string, unknown>): void;
    /** Wait for an event matching `match`, from the start of the log. */
    waitFor(match: (e: Event) => boolean, ms?: number): Promise<Event>;
    close(): void;
}

export type Event = { type: string; [key: string]: any };

const TOOLS = [
    {
        name: "screenshot",
        description: "Take a screenshot.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
    },
    {
        name: "click",
        description: "Click at a point.",
        inputSchema: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
        },
    },
    {
        name: "key",
        description: "Press keys.",
        inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } } },
    },
];

/** A stand-in for the PiKVM server: three tools, `key` asks for approval through the chat thread. */
function fakePikvm(fixture: () => Fixture): BuiltinMcp {
    return {
        name: "pikvm",
        tools: TOOLS.map((t) => t.name),
        async handle(req, ctx) {
            const f = fixture();
            f.mcpAuth.push(req.headers.get("authorization"));
            const msg = (await req.json()) as { id?: number; method: string; params?: Record<string, any> };
            const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id ?? null, result });
            if (msg.id === undefined) return new Response(null, { status: 202 });
            switch (msg.method) {
                case "initialize":
                    return reply({
                        protocolVersion: "2025-06-18",
                        capabilities: { tools: {} },
                        serverInfo: { name: "pikvm", version: "0" },
                    });
                case "tools/list":
                    return reply({ tools: TOOLS });
                case "tools/call": {
                    const { name, arguments: args } = msg.params as { name: string; arguments: any };
                    if (name === "key") {
                        const decision = await f.chat.askApproval("pikvm", {
                            conversationId: ctx.conversationId,
                            tool: "key",
                            title: `Press ${args.keys.join(", ")} on the PiKVM?`,
                            summary: `Press ${args.keys.join(", ")}`,
                            reasons: ["a chord that closes a window"],
                            arguments: args,
                            signal: req.signal,
                        });
                        if (decision !== "approved")
                            return reply({ content: [{ type: "text", text: `approval_denied: ${decision}` }], isError: true });
                    }
                    // Recorded after the approval, so a denied action leaves nothing behind.
                    f.calls.push({ tool: name, args, conversationId: ctx.conversationId });
                    return reply({
                        content: [
                            {
                                type: "text",
                                text: name === "screenshot" ? "Screen is 320 x 180" : `${name} done`,
                            },
                        ],
                    });
                }
                default:
                    return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
            }
        },
    };
}

export async function startFixture(extra: Partial<ChatServerOptions> = {}): Promise<Fixture> {
    const dataDir = tempDir("chat-server-test-");
    const model = await startFakeModel();
    let fixture!: Fixture;
    const start = () =>
        createChatServer({
            dataDir,
            apiPath: API,
            refreshCatalog: false,
            mcp: [fakePikvm(() => fixture)],
            instructions: "You control a PiKVM.",
            ...extra,
        });
    let chat = await start();
    const server: Server = createServer((incoming, outgoing) => {
        const request = toRequest(incoming, `http://${incoming.headers.host}`);
        fixture.chat.handleRest(request).then((response) => sendResponse(outgoing, response));
    });
    server.on("upgrade", (req, socket, head) => fixture.chat.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    fixture = {
        chat,
        model,
        dataDir,
        origin,
        calls: [],
        mcpAuth: [],
        api: (path, init = {}) =>
            fetch(`${origin}${API}${path}`, {
                ...init,
                headers: {
                    "x-chat-request": "1",
                    ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
                    ...init.headers,
                },
                ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
            }),
        connect: () =>
            new Promise((resolve, reject) => {
                const ws = new WebSocket(`${origin.replace("http", "ws")}${WS_PATH}`);
                const events: Event[] = [];
                const waiters: { match: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
                ws.on("message", (data) => {
                    const event = JSON.parse(data.toString()) as Event;
                    events.push(event);
                    for (const w of [...waiters]) {
                        if (!w.match(event)) continue;
                        waiters.splice(waiters.indexOf(w), 1);
                        w.resolve(event);
                    }
                });
                ws.once("error", reject);
                ws.once("open", () =>
                    resolve({
                        events,
                        send: (event) => ws.send(JSON.stringify(event)),
                        waitFor(match, ms = 60_000) {
                            const hit = events.find(match);
                            if (hit) return Promise.resolve(hit);
                            return new Promise((res, rej) => {
                                const timer = setTimeout(
                                    () =>
                                        rej(
                                            new Error(
                                                `timed out; saw ${events.map((e) => e.type + (e.error ? `:${e.error.code}` : "")).join(", ")}`,
                                            ),
                                        ),
                                    ms,
                                );
                                waiters.push({
                                    match,
                                    resolve: (e) => {
                                        clearTimeout(timer);
                                        res(e);
                                    },
                                });
                            });
                        },
                        close: () => ws.close(),
                    }),
                );
            }),
        async restart() {
            await fixture.chat.stop();
            chat = await start();
            fixture.chat = chat;
        },
        async close() {
            await fixture.chat.stop();
            await model.stop();
            server.closeAllConnections();
            server.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };

    // The provider the agent talks to: the fake model, through the gateway. The key is a canary: it must never reach
    // the agent.
    const put = await fixture.api("/settings/agent.providers", {
        method: "PUT",
        json: {
            value: {
                fake: {
                    enabled: true,
                    baseUrl: model.url,
                    api: "openai-completions",
                    apiKey: CANARY_KEY,
                    models: [{ id: "fake-1" }],
                },
            },
        },
    });
    if (!put.ok) throw new Error(`could not configure the provider: ${put.status} ${await put.text()}`);
    return fixture;
}

/** A provider key the agent must never see. */
export const CANARY_KEY = "sk-canary-9f3a1c7e5b";
