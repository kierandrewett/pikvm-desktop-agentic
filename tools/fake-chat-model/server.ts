// A chat model stand-in for tests and end-to-end runs of the screen watch: the OpenAI-style chat-completions route the watch's two
// small text requests go to (through the chat server's own provider path): step 1 (READ: the pop-up's text to facts) and step 2 (JUDGE:
// the facts to a verdict). Scripted per step, deterministic, free; it records every request so a test can assert what the host sent:
// which step, the model, the instructions, the message, that JSON mode was asked for, and that no image was in it.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-chat-model/server.ts --port 4530
// Point a provider at it in Settings, Providers (base URL http://127.0.0.1:4530/v1, API openai-completions, any key) and make a model of it
// the default model.
//
// Control API (plain JSON):
//   POST /__fake/script   { read?: Step, judge?: Step, answers?, delayMs?, failFirst? }
//                         where Step = { answers?: string[], delayMs?: number, failFirst?: { status: number, count: number } | null,
//                         hang?: boolean }. A step's script is for its requests only; the top-level fields are the same keys for
//                         both steps (a step's own wins). answers: what the next requests answer, in order (the last repeats; the
//                         default for READ is the text as facts, for JUDGE a verdict that notifies); delayMs: a wait before every
//                         answer (the fake's, not a real model's); failFirst: fail the next `count` requests; hang: never answer.
//   GET  /__fake/requests -> every request: { at, authorization, model, step, system, user, hasImage, json, maxTokens, answered }
//   POST /__fake/reset
//
// Only erasable TypeScript is used, so Node can strip the types without a build step.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

export interface RecordedRequest {
    at: number;
    authorization: string | null;
    model: string | null;
    /** Which of the two steps this is, told by its instructions ("reading step" or "judging step"); "other" if neither. */
    step: "read" | "judge" | "other";
    system: string;
    user: string;
    /** Whether any part of the request was an image: the watch must never send one. */
    hasImage: boolean;
    /** The request asked for JSON mode (`response_format`). */
    json: boolean;
    maxTokens: number | null;
    answered: number;
}

/** What one step answers, and when. */
export interface StepScript {
    answers?: string[];
    delayMs?: number;
    failFirst?: { status: number; count: number } | null;
    hang?: boolean;
}

export interface FakeChatModel {
    port: number;
    /** `http://127.0.0.1:<port>/v1`, a provider's base URL. */
    url: string;
    requests: RecordedRequest[];
    script(over: StepScript & { read?: StepScript; judge?: StepScript }): void;
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

/** The scripts, per step: what each answers, how it is delayed and failed. A step with no script of its own follows the shared one. */
interface Scripts {
    shared: StepScript;
    read: StepScript;
    judge: StepScript;
}

/** The facts of a pop-up as READ would write them, made from its text alone: what a model that copies faithfully answers. */
function echoFacts(user: string): string {
    const lines = user.replace(/^Text:\n/, "").split("\n").filter((line) => line.trim() !== "");
    return JSON.stringify({ source: null, from: null, subject: null, text: lines.join(" / "), when: null, numbers_and_codes: [], actions: [], urgent_words: [] });
}

/** A verdict that notifies, with the start of the message as the body: what a model that always says yes answers. */
function echoVerdict(user: string): string {
    return JSON.stringify({ reason: "other", notify: true, body: `A notification about: ${user.replace(/\s+/g, " ").slice(0, 60)}`, title: null });
}

export async function startFakeChatModel(options: { port?: number; host?: string } = {}): Promise<FakeChatModel> {
    let requests: RecordedRequest[] = [];
    const fresh = (): Scripts => ({ shared: { answers: [], delayMs: 0, failFirst: null }, read: {}, judge: {} });
    let scripts = fresh();
    /** How many answers each step has given from its list. */
    const used = { read: 0, judge: 0, other: 0 };

    /** A step's effective script: its own keys, else the shared ones. */
    const scriptFor = (step: RecordedRequest["step"]): StepScript => {
        const own = step === "read" ? scripts.read : step === "judge" ? scripts.judge : {};
        return {
            answers: own.answers ?? scripts.shared.answers ?? [],
            delayMs: own.delayMs ?? scripts.shared.delayMs ?? 0,
            failFirst: own.failFirst !== undefined ? own.failFirst : (scripts.shared.failFirst ?? null),
            hang: own.hang ?? scripts.shared.hang ?? false,
        };
    };

    /** Merge a posted script into the stored one: a key that is present replaces, `answers` restarts that step's list. */
    const apply = (target: StepScript, over: StepScript, step: "read" | "judge" | "other"): void => {
        if (over.answers !== undefined) {
            target.answers = over.answers;
            used[step] = 0;
        }
        if (over.delayMs !== undefined) target.delayMs = over.delayMs;
        if ("failFirst" in over) target.failFirst = over.failFirst ? { ...over.failFirst } : null;
        if (over.hang !== undefined) target.hang = over.hang;
    };

    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake-chat-model");
        try {
            if (url.pathname === "/__fake/script" && req.method === "POST") {
                const body = (await readJson(req)) as StepScript & { read?: StepScript; judge?: StepScript };
                apply(scripts.shared, body, "other");
                if (body.answers !== undefined) {
                    used.read = 0;
                    used.judge = 0;
                }
                if (body.read) apply(scripts.read, body.read, "read");
                if (body.judge) apply(scripts.judge, body.judge, "judge");
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
            const system = flat(content(0));
            const step: RecordedRequest["step"] = /judging step/.test(system) ? "judge" : /reading step/.test(system) ? "read" : "other";
            const maxTokens = prop(body, "max_tokens");
            const record: RecordedRequest = {
                at: Date.now(),
                authorization,
                model: typeof prop(body, "model") === "string" ? (prop(body, "model") as string) : null,
                step,
                system,
                user: flat(content(1)),
                hasImage: /image_url|data:image|"type":"image/.test(JSON.stringify(body)),
                json: prop(body, "response_format", "type") === "json_object",
                maxTokens: typeof maxTokens === "number" ? maxTokens : null,
                answered: 200,
            };
            requests.push(record);
            const script = scriptFor(step);
            const { failFirst } = script;
            if (failFirst && failFirst.count > 0) {
                failFirst.count--;
                record.answered = failFirst.status;
                return send(res, failFirst.status, { error: { message: "scripted failure" } });
            }
            if (script.hang) {
                record.answered = 0;
                return; // never answered: the host's own time limit is what ends it
            }
            if ((script.delayMs ?? 0) > 0) await new Promise((done) => setTimeout(done, script.delayMs));
            const list = script.answers ?? [];
            const scripted = list.length === 0 ? undefined : list[Math.min(used[step]++, list.length - 1)];
            const text = scripted ?? (step === "read" ? echoFacts(record.user) : step === "judge" ? echoVerdict(record.user) : `A sentence about: ${record.user.slice(0, 60)}`);
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
            apply(scripts.shared, over, "other");
            if (over.answers !== undefined) {
                used.read = 0;
                used.judge = 0;
            }
            if (over.read) apply(scripts.read, over.read, "read");
            if (over.judge) apply(scripts.judge, over.judge, "judge");
        },
        reset() {
            requests = [];
            scripts = fresh();
            used.read = 0;
            used.judge = 0;
            used.other = 0;
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
