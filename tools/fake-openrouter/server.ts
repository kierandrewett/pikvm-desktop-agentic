// An OpenRouter stand-in for tests and end-to-end runs of the screen watch: the chat-completions route the image model is
// asked through, and the decisions route (/api/alpha/decisions) Jev is. Scripted, deterministic, free; it records every
// request so a test can assert what the host sent (the model, the prompt, the image's hash, the state, the key).
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-openrouter/server.ts --port 4530
// Point a provider at it in Settings: base URL http://127.0.0.1:4530/api/v1, any key.
//
// Control API (plain JSON):
//   POST /__fake/script   { describe?: string[], noul?: number[], failFirst?: { status: number, count: number } }
//                         describe: the descriptions the next image calls answer, in order (the last repeats);
//                         noul: Jev's probability of yes for the next decisions, in order (the last repeats; default 0.02);
//                         failFirst: answer the next `count` calls of either kind with `status` (to see retries).
//   POST /__fake/script   also { summary?: string[], delayMs?: number }: the sentences the next text-only (summary) calls answer, and a wait before
//                         every answer, so a run can put a number on "a model that takes this long" (the delay is the fake's, not a real model's).
//   GET  /__fake/requests -> every call: { kind, at, authorization, model, ... }
//   POST /__fake/reset
//
// Only erasable TypeScript is used, so Node can strip the types without a build step.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

export interface RecordedCall {
    kind: "describe" | "decide" | "summarise";
    at: number;
    authorization: string | null;
    model: string | null;
    /** describe: the system prompt, the user's text part, and the image (hash and size, not the bytes). */
    system?: string;
    text?: string;
    image?: { sha256: string; bytes: number; mime: string };
    /** summarise: the text the model was given (a summary request carries no image). */
    summaryInput?: string;
    /** decide: what Jev was given. */
    state?: Record<string, unknown>;
    questions?: Record<string, unknown>;
    answered: number;
}

export interface FakeOpenRouter {
    port: number;
    /** `http://127.0.0.1:<port>/api/v1`, a provider's base URL. */
    url: string;
    calls: RecordedCall[];
    script(over: { describe?: string[]; noul?: number[]; failFirst?: { status: number; count: number } | null }): void;
    reset(): void;
    close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? {} : JSON.parse(text);
}

const prop = (value: unknown, ...path: (string | number)[]): unknown => {
    let at = value;
    for (const key of path) {
        if (at === null || typeof at !== "object") return undefined;
        at = Reflect.get(at, key);
    }
    return at;
};

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
};

export async function startFakeOpenRouter(options: { port?: number; host?: string } = {}): Promise<FakeOpenRouter> {
    let calls: RecordedCall[] = [];
    let describe: string[] = [];
    let noul: number[] = [];
    let failFirst: { status: number; count: number } | null = null;
    let summaries: string[] = [];
    let summarised = 0;
    let delayMs = 0;
    let described = 0;
    let decided = 0;

    const next = <T>(queue: T[], fallback: T, used: number): T => (queue.length === 0 ? fallback : queue[Math.min(used, queue.length - 1)]!);

    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake-openrouter");
        try {
            if (url.pathname === "/__fake/script" && req.method === "POST") {
                const body = await readJson(req);
                if (Array.isArray(prop(body, "describe"))) {
                    describe = prop(body, "describe") as string[];
                    described = 0;
                }
                if (Array.isArray(prop(body, "noul"))) {
                    noul = prop(body, "noul") as number[];
                    decided = 0;
                }
                if (Array.isArray(prop(body, "summary"))) {
                    summaries = prop(body, "summary") as string[];
                    summarised = 0;
                }
                if (typeof prop(body, "delayMs") === "number") delayMs = prop(body, "delayMs") as number;
                if ("failFirst" in (body as object)) failFirst = (prop(body, "failFirst") as typeof failFirst) ?? null;
                return send(res, 200, { ok: true });
            }
            if (url.pathname === "/__fake/requests") return send(res, 200, { calls });
            if (url.pathname === "/__fake/reset" && req.method === "POST") {
                service.reset();
                return send(res, 200, { ok: true });
            }

            const isChat = url.pathname === "/api/v1/chat/completions";
            const isDecisions = url.pathname === "/api/alpha/decisions";
            if (!(isChat || isDecisions) || req.method !== "POST") return send(res, 404, { error: { message: "not found" } });

            const body = await readJson(req);
            const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
            const model = typeof prop(body, "model") === "string" ? (prop(body, "model") as string) : null;
            const call: RecordedCall = { kind: isChat ? "describe" : "decide", at: Date.now(), authorization, model, answered: 200 };
            calls.push(call);

            if (failFirst && failFirst.count > 0) {
                failFirst.count--;
                call.answered = failFirst.status;
                return send(res, failFirst.status, { error: { message: "scripted failure" } }, failFirst.status === 429 ? { "retry-after": "0" } : {});
            }
            if (!authorization?.startsWith("Bearer ") || authorization.length < 12) {
                call.answered = 401;
                return send(res, 401, { error: { message: "no key" } });
            }

            if (isChat) {
                const messages = prop(body, "messages");
                const parts = prop(messages, 1, "content");
                call.system = String(prop(messages, 0, "content") ?? "");
                if (Array.isArray(parts)) {
                    const url64 = String(prop(parts.find((part) => prop(part, "type") === "image_url"), "image_url", "url") ?? "");
                    const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(url64);
                    if (match) {
                        const bytes = Buffer.from(match[2]!, "base64");
                        call.image = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mime: match[1]! };
                    }
                    call.text = String(prop(parts.find((part) => prop(part, "type") === "text"), "text") ?? "");
                }
                if (!call.image) {
                    const given = prop(messages, 1, "content");
                    if (typeof given !== "string") {
                        call.answered = 400;
                        return send(res, 400, { error: { message: "no image" } });
                    }
                    call.kind = "summarise";
                    call.summaryInput = given;
                    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
                    const sentence = next(summaries, `A short sentence about: ${given.slice(0, 60)}`, summarised++);
                    return send(res, 200, { id: "gen-fake", model, choices: [{ message: { role: "assistant", content: sentence } }], usage: { prompt_tokens: 120, completion_tokens: 20, cost: 0.00001 } });
                }
                const text = next(describe, `A screen (${call.image.sha256.slice(0, 8)}).`, described++);
                return send(res, 200, { id: "gen-fake", model, choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.00005 } });
            }

            const state = prop(body, "state");
            const questions = prop(body, "questions");
            call.state = state as Record<string, unknown>;
            call.questions = questions as Record<string, unknown>;
            if (model !== "typesafe/jev-1.14" || prop(questions, "notify", "type") !== "noul") {
                call.answered = 400;
                return send(res, 400, { error: { message: "expected the decisions model and a noul question named notify" } });
            }
            return send(res, 200, { model, answers: { notify: { type: "noul", noul: next(noul, 0.02, decided++) } }, usage: { cost: 0.00002 } });
        } catch (error) {
            send(res, 500, { error: { message: (error as Error).message } });
        }
    });

    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => done());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake-openrouter: no TCP address");
    const origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

    const service: FakeOpenRouter = {
        port: address.port,
        url: `${origin}/api/v1`,
        get calls() {
            return calls;
        },
        script(over) {
            if (over.describe) {
                describe = over.describe;
                described = 0;
            }
            if (over.noul) {
                noul = over.noul;
                decided = 0;
            }
            if (over.failFirst !== undefined) failFirst = over.failFirst;
        },
        reset() {
            calls = [];
            describe = [];
            noul = [];
            failFirst = null;
            described = 0;
            decided = 0;
        },
        close: () =>
            new Promise<void>((done) => {
                server.close(() => done());
                server.closeAllConnections();
            }),
    };
    return service;
}

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    const port = Number(argValue("port") ?? process.env.PORT ?? 4530);
    const host = argValue("host") ?? process.env.HOST ?? "127.0.0.1";
    void startFakeOpenRouter({ port, host }).then((fake) => {
        console.log(`fake-openrouter listening on ${fake.url}`);
        const stop = () => void fake.close().then(() => process.exit(0));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}
