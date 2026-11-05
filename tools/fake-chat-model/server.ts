// A chat model stand-in for tests and end-to-end runs of the screen watch: the OpenAI-style chat-completions route the watch's one
// small text request goes to (through the chat server's own provider path). Scripted, deterministic, free; it records every request so a
// test can assert what the host sent: the model, the instructions, the message, and that no image was in it.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-chat-model/server.ts --port 4530
// Point a provider at it in Settings, Providers (base URL http://127.0.0.1:4530/v1, API openai-completions, any key) and make a model of it
// the default model.
//
// Control API (plain JSON):
//   POST /__fake/script   { answers?: string[], delayMs?: number, failFirst?: { status: number, count: number } | null }
//                         answers: what the next requests answer, in order (the last repeats; default echoes the start of the message);
//                         delayMs: a wait before every answer (the fake's, not a real model's); failFirst: fail the next `count` requests.
//   GET  /__fake/requests -> every request: { at, authorization, model, system, user, hasImage, answered }
//   POST /__fake/reset
//
// Only erasable TypeScript is used, so Node can strip the types without a build step.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

export interface RecordedRequest {
    at: number;
    authorization: string | null;
    model: string | null;
    system: string;
    user: string;
    /** Whether any part of the request was an image: the watch must never send one. */
    hasImage: boolean;
    answered: number;
}

export interface FakeChatModel {
    port: number;
    /** `http://127.0.0.1:<port>/v1`, a provider's base URL. */
    url: string;
    requests: RecordedRequest[];
    script(over: { answers?: string[]; delayMs?: number; failFirst?: { status: number; count: number } | null }): void;
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

const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

export async function startFakeChatModel(options: { port?: number; host?: string } = {}): Promise<FakeChatModel> {
    let requests: RecordedRequest[] = [];
    let answers: string[] = [];
    let used = 0;
    let delayMs = 0;
    let failFirst: { status: number; count: number } | null = null;

    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake-chat-model");
        try {
            if (url.pathname === "/__fake/script" && req.method === "POST") {
                const body = await readJson(req);
                if (Array.isArray(prop(body, "answers"))) {
                    answers = prop(body, "answers") as string[];
                    used = 0;
                }
                if (typeof prop(body, "delayMs") === "number") delayMs = prop(body, "delayMs") as number;
                if ("failFirst" in (body as object)) failFirst = (prop(body, "failFirst") as typeof failFirst) ?? null;
                return send(res, 200, { ok: true });
            }
            if (url.pathname === "/__fake/requests") return send(res, 200, { requests });
            if (url.pathname === "/__fake/reset" && req.method === "POST") {
                service.reset();
                return send(res, 200, { ok: true });
            }
            if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") return send(res, 404, { error: { message: "not found" } });

            const body = await readJson(req);
            const messages = prop(body, "messages");
            const content = (index: number): unknown => prop(messages, index, "content");
            const flat = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));
            const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
            const record: RecordedRequest = {
                at: Date.now(),
                authorization,
                model: typeof prop(body, "model") === "string" ? (prop(body, "model") as string) : null,
                system: flat(content(0)),
                user: flat(content(1)),
                hasImage: /image_url|data:image|"type":"image/.test(JSON.stringify(body)),
                answered: 200,
            };
            requests.push(record);
            if (failFirst && failFirst.count > 0) {
                failFirst.count--;
                record.answered = failFirst.status;
                return send(res, failFirst.status, { error: { message: "scripted failure" } });
            }
            if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
            const scripted = answers.length === 0 ? undefined : answers[Math.min(used++, answers.length - 1)];
            const text = scripted ?? `A sentence about: ${record.user.slice(0, 60)}`;
            return send(res, 200, { id: "gen-fake", model: record.model, choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 120, completion_tokens: 20 } });
        } catch (error) {
            send(res, 500, { error: { message: (error as Error).message } });
        }
    });

    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => done());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake-chat-model: no TCP address");
    const origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

    const service: FakeChatModel = {
        port: address.port,
        url: `${origin}/v1`,
        get requests() {
            return requests;
        },
        script(over) {
            if (over.answers) {
                answers = over.answers;
                used = 0;
            }
            if (over.delayMs !== undefined) delayMs = over.delayMs;
            if (over.failFirst !== undefined) failFirst = over.failFirst;
        },
        reset() {
            requests = [];
            answers = [];
            used = 0;
            delayMs = 0;
            failFirst = null;
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
    void startFakeChatModel({ port, host }).then((fake) => {
        console.log(`fake-chat-model listening on ${fake.url}`);
        const stop = () => void fake.close().then(() => process.exit(0));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}
