/**
 * A scripted OpenAI-compatible model for tests and end-to-end runs of the chat server. Lifted from ~/dev/chat's
 * `e2e/fixtures/fake-llm.ts` (its chat-completions wire, directives and server-call answers), on Node, plus scenarios
 * that drive the PiKVM tools. It streams scripted replies, so agent runs are deterministic and cost nothing, and it
 * records every request so a test can assert what the agent sent: the tool list, the credentials, the prompt.
 *
 * The last user message selects a behaviour:
 *   "pikvm:click"      screenshot, then one click at the centre of the frame, then a closing line
 *   "pikvm:approve"    screenshot, then `alt+F4`, which the PiKVM server asks about, then a closing line
 *   "please click ..." / "please approve ..."   the same two scenarios, for a person typing
 *   "call:<tool> <json>" calls any tool by name with the given JSON arguments, then says "Done."
 *   "ask:<preset>"     calls the `ask` tool with a preset from ASK_PRESETS (single, multi)
 *   "think:<text>"     streams reasoning, then <text>
 *   "slow:<text>"      streams <text> a few characters at a time for several seconds (stop and resume tests)
 *   "http:<status>"    fails the request with that status
 *   "length:<text>"    streams <text>, then stops at the output limit
 *   "tools?"           answers with the sorted names of the tools it was offered
 *   anything else      echoes "You said: <text>" in a few chunks
 * The chat server's own title call (conversations/titles.ts) is answered with "Title about <first words>".
 *
 * A step is chosen from the conversation itself: the number of tool results after the last user message. That keeps a
 * resumed process (a new omp started from the session file) on the same script.
 *
 * Run it by hand: `node --experimental-strip-types tools/fake-model/server.ts` (PORT, default 4517; HOST, default 127.0.0.1).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface FakeModel {
    /** `http://127.0.0.1:<port>/v1`, the provider's base URL. */
    url: string;
    /** Every agent request body, in order (the chat server's own title calls are kept out). */
    requests: ChatRequest[];
    /** Title requests from the chat server, in order. */
    titles: ChatRequest[];
    /** The credentials of each request, to prove what the agent holds. */
    auth: { authorization: string | null; "x-api-key": string | null }[];
    stop(): Promise<void>;
}

export interface ChatRequest {
    model?: string;
    messages: Message[];
    tools?: { type: string; function: { name: string; description?: string } }[];
    [key: string]: unknown;
}

interface Message {
    role: string;
    content?: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
}

export interface FakeModelOptions {
    port?: number;
    /** The address to listen on. Loopback unless a container has to be reached from another one. */
    host?: string;
    /** Where the `pikvm:click` scenario clicks, in the reference frame. Default 160,90 (the centre of 320x180). */
    click?: { x: number; y: number };
    /** Characters per frame and delay between frames for `slow:`. */
    slowChars?: number;
    slowDelayMs?: number;
}

/** Arguments for "ask:<preset>": the `ask` tool's question list. */
export const ASK_PRESETS: Record<string, { questions: unknown[] }> = {
    single: {
        questions: [
            {
                id: "db",
                header: "Database",
                question: "Which database should I use?",
                options: [{ label: "SQLite", description: "One file, no server" }, { label: "Postgres" }],
                recommended: 0,
            },
        ],
    },
    multi: {
        questions: [
            {
                id: "features",
                question: "Which features should the first release include?",
                options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }],
                multi: true,
            },
        ],
    },
};

const chunk = (delta: Record<string, unknown>, finish: string | null = null, model = "fake-1") => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
});

const usage = () => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-1",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

function sse(chunks: unknown[], delayMs = 5, signal?: AbortSignal): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream({
        async start(ctrl) {
            for (const c of chunks) {
                if (signal?.aborted) return ctrl.close();
                ctrl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
                await sleep(delayMs).catch(() => undefined);
            }
            ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
            ctrl.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Message text without the runtime's injected <system-reminder> blocks. */
function textOf(content: unknown): string {
    const raw =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((p: { text?: string }) => p.text ?? "").join("")
              : "";
    return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

/** The user's own words: the message text up to the lists the server appends (`Attached files`, `Mentioned tools`). */
function userWords(messages: Message[]): string {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return textOf(last?.content)
        .split(/\n\n(?:Attached files|Mentioned tools|Marked images)/)[0]!
        .trim();
}

/** Tool results after the last user message: which step of a scenario this request is. */
function stepOf(messages: Message[]): number {
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    return messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
}

function toolCall(name: string, args: unknown, id = `call_${name}`): unknown[] {
    return [
        chunk({
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        }),
        chunk({}, "tool_calls"),
    ];
}

function words(text: string, size = 8): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < text.length; i += size) out.push(chunk({ content: text.slice(i, i + size) }));
    out.push(chunk({}, "stop"));
    return out;
}

const PIKVM = "mcp__pikvm_";

/** The scripted steps of a PiKVM scenario: a screenshot, one action, a closing line. */
function pikvmScenario(kind: "click" | "approve", step: number, click: { x: number; y: number }): unknown[] {
    if (step === 0) return toolCall(`${PIKVM}screenshot`, {}, "call_look");
    if (step === 1) {
        return kind === "click"
            ? toolCall(`${PIKVM}click`, { x: click.x, y: click.y }, "call_act")
            : toolCall(`${PIKVM}key`, { keys: ["alt+F4"] }, "call_act");
    }
    return words(kind === "click" ? "I clicked the centre of the screen." : "I pressed Alt+F4.");
}

function titleAnswer(system: string, prompt: string): string | undefined {
    if (!system.includes("You write short titles")) return undefined;
    const msg = prompt.match(/User message:\n([\s\S]*)$/)?.[1] ?? prompt;
    return `"Title about ${msg.split(/\s+/).filter(Boolean).slice(0, 3).join(" ")}."`;
}

async function readJson(req: IncomingMessage): Promise<ChatRequest> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as ChatRequest;
}

export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
    const requests: ChatRequest[] = [];
    const titles: ChatRequest[] = [];
    const auth: FakeModel["auth"] = [];
    const click = options.click ?? { x: 160, y: 90 };

    async function answer(req: IncomingMessage, signal: AbortSignal): Promise<Response> {
        const path = new URL(req.url ?? "/", "http://fake").pathname;
        if (req.method === "GET" && path.endsWith("/models")) {
            return Response.json({
                object: "list",
                data: [{ id: "fake-1", object: "model" }, { id: "fake-2", object: "model" }],
            });
        }
        if (req.method !== "POST" || !path.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const body = await readJson(req);
        const system = JSON.stringify(body.messages?.[0] ?? "");
        const named = titleAnswer(system, textOf(body.messages.at(-1)?.content));
        if (named) {
            titles.push(body);
            return Response.json({
                id: "chatcmpl-naming",
                object: "chat.completion",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: named }, finish_reason: "stop" }],
                usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
            });
        }
        requests.push(body);
        auth.push({
            authorization: req.headers.authorization ?? null,
            "x-api-key": (req.headers["x-api-key"] as string | undefined) ?? null,
        });
        const messages = body.messages;
        const text = userWords(messages);
        const step = stepOf(messages);
        const out: unknown[] = [chunk({ role: "assistant", content: "" })];
        const status = /^http:(\d{3})$/.exec(text)?.[1];
        const scenario = /^(?:pikvm:|please )(click|approve)\b/i.exec(text)?.[1]?.toLowerCase() as
            | "click"
            | "approve"
            | undefined;
        const lastRole = messages.at(-1)?.role;
        if (status) {
            return new Response(JSON.stringify({ error: { message: "scripted model error" } }), {
                status: Number(status),
                headers: { "content-type": "application/json" },
            });
        }
        if (scenario) out.push(...pikvmScenario(scenario, step, click));
        else if (text === "tools?") {
            const names = (body.tools ?? []).map((t) => t.function.name).sort();
            out.push(...words(`Tools: ${names.join(", ")}`));
        } else if (/^ask:\w+$/.test(text) && ASK_PRESETS[text.slice(4)]) {
            if (step === 0) out.push(...toolCall("ask", ASK_PRESETS[text.slice(4)], "call_ask"));
            else out.push(...words("Thanks, noted."));
        } else if (text.startsWith("call:")) {
            const rest = text.slice(5).trim();
            const space = rest.indexOf(" ");
            const name = space < 0 ? rest : rest.slice(0, space);
            const args = space < 0 ? {} : (JSON.parse(rest.slice(space + 1)) as unknown);
            if (lastRole === "tool") out.push(...words("Done."));
            else out.push(...toolCall(name, args, "call_x"));
        } else if (text.startsWith("length:")) {
            out.push(chunk({ content: text.slice(7) }), chunk({}, "length"));
        } else if (text.startsWith("think:")) {
            out.push(chunk({ reasoning_content: "Let me think. " }), chunk({ reasoning_content: "Done thinking." }));
            out.push(chunk({ content: text.slice(6) }), chunk({}, "stop"));
        } else if (text.startsWith("slow:")) {
            const reply = text.slice(5) || "Taking my time. ".repeat(20);
            const size = options.slowChars ?? 4;
            for (let i = 0; i < reply.length; i += size) out.push(chunk({ content: reply.slice(i, i + size) }));
            out.push(chunk({}, "stop"), usage());
            return sse(out, options.slowDelayMs ?? 80, signal);
        } else {
            out.push(...words(`You said: ${text}`, 6));
        }
        out.push(usage());
        return sse(out, 5, signal);
    }

    const server: Server = createServer((req, res) => {
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        answer(req, controller.signal)
            .catch((err: Error) => new Response(String(err.message), { status: 500 }))
            .then(async (response) => {
                res.writeHead(response.status, Object.fromEntries(response.headers));
                if (!response.body) return void res.end();
                const reader = response.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (res.destroyed) return void (await reader.cancel());
                    res.write(value);
                }
                res.end();
            });
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        titles,
        auth,
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const fake = await startFakeModel({ port: Number(process.env.PORT ?? 4517), host: process.env.HOST });
    console.log(`fake model on ${fake.url}`);
}
