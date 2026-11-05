import { createHash } from "node:crypto";
import { DECISIVE, JEV_MODEL } from "./limits";

/**
 * The two OpenRouter calls behind a screen watch.
 *
 *  1. An image model reads a settled frame into a short factual description (chat completions with an image).
 *  2. Jev, the decisions model, answers one yes/no question about the previous and the new description and the person's
 *     rule. It returns no text: only a probability, and only a decisive one is acted on.
 *
 * Both are retried on 429 and 5xx with backoff. Jev's answers are cached by the hash of the request body, so a repeat of
 * the same two descriptions and rule costs nothing; descriptions are cached by the hash of the frame and the model.
 * The key is sent in one header and never put in an error, a log line or a result.
 */

export interface ModelProvider {
    /** `https://openrouter.ai/api/v1`, no trailing slash. */
    baseUrl: string;
    apiKey: string;
}

export class ModelError extends Error {
    constructor(
        message: string,
        readonly kind: "auth" | "http" | "shape" | "network",
        readonly status?: number,
    ) {
        super(message);
        this.name = "ModelError";
    }
}

export interface Described {
    text: string;
    /** What OpenRouter says the call cost, in US dollars, when it says. */
    costUsd?: number;
    cached: boolean;
}

export type Verdict = "yes" | "no" | "undecided";

export interface Decided {
    /** Jev's probability of yes. */
    noul: number;
    verdict: Verdict;
    costUsd?: number;
    cached: boolean;
}

export interface ModelClient {
    describe(provider: ModelProvider, model: string, jpeg: Buffer, signal?: AbortSignal): Promise<Described>;
    /** Read a crop of the screen's notification corner (fast alerts): the app, the sender or caller, the first line. */
    describeAlert(provider: ModelProvider, model: string, jpeg: Buffer, signal?: AbortSignal): Promise<Described>;
    decide(
        provider: ModelProvider,
        input: { previous: string; current: string; rule: string },
        signal?: AbortSignal,
    ): Promise<Decided>;
}

export interface ModelClientOptions {
    fetch?: typeof fetch;
    /** Waits between attempts; a test passes one that does not wait. */
    sleep?: (ms: number) => Promise<void>;
    /** Attempts in all, the first included. Default 4. */
    attempts?: number;
    timeoutMs?: number;
}

export const DESCRIBE_PROMPT =
    "You describe a computer screenshot for someone who cannot see it. Reply in plain text, at most three sentences, " +
    "with no markdown and no preamble. Lead with the most important thing on the screen: a dialog, popup, error message, " +
    "prompt or progress or status line, with its exact text. Then say which application or window is in front (and the " +
    "operating system if it is obvious), then the one or two most important other lines of text. If the screen is " +
    "blank, black or shows no signal, say exactly that. Do not describe colours or layout, and do not guess at what you " +
    "cannot read.";

/** What `describeAlert` answers, word for word, when the crop shows no notification. */
export const NO_NOTIFICATION_TEXT = "No notification.";

export const ALERT_PROMPT =
    "You read a cropped corner of a computer screen where a notification pop-up (a toast) may be showing: a new email, " +
    "a chat message (such as Microsoft Teams), or an incoming call. Reply in plain text, at most three sentences, with " +
    "no markdown and no preamble. If a notification is showing, say which application it is from (for example Outlook " +
    "or Teams), who sent it or is calling, and the first line of the message or the email's subject, quoted as it " +
    "reads. If it is a call, begin with \"Incoming call\", say who is calling, and say whether Accept and Decline " +
    "buttons are shown. If the crop shows no notification pop-up (only a desktop, a taskbar, a clock or an ordinary " +
    `window), reply exactly: ${NO_NOTIFICATION_TEXT} Do not guess at text you cannot read.`;

const QUESTION_NO_RULE =
    "previous and current describe what a remote computer's screen showed a moment ago and now. Is the change from " +
    "previous to current important enough to interrupt the person, who is away from the screen? Yes for: a dialog, " +
    "prompt or error appearing; a task or install finishing or failing; the machine restarting, shutting down, " +
    "locking, or someone signing in or out; a different application taking over the screen. No for: a cursor or " +
    "caret moving, a clock or counter updating, a few words of text changing, scrolling, hover highlights, " +
    "animations, a progress bar advancing, or the same screen described in different words.";

const QUESTION_WITH_RULE =
    "previous and current describe what a remote computer's screen showed a moment ago and now. The person is away " +
    "from the screen and asked to be told about what rule says. Answer yes only if the change from previous to " +
    "current matches what rule asks for (by meaning, not exact words). Answer no for any other change, however " +
    "interesting, and for the same screen described in different words.";

/** The Jev request for one check. Exported so a test can see exactly what is asked. */
export function decisionRequest(input: { previous: string; current: string; rule: string }): Record<string, unknown> {
    const rule = input.rule.trim();
    return {
        model: JEV_MODEL,
        state: { previous: input.previous, current: input.current, rule: rule === "" ? "(none)" : rule },
        questions: {
            notify: { type: "noul", instructions: rule === "" ? QUESTION_NO_RULE : QUESTION_WITH_RULE },
        },
    };
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

class Lru<V> {
    private readonly map = new Map<string, V>();
    constructor(private readonly max: number) {}
    get(key: string): V | undefined {
        const value = this.map.get(key);
        if (value === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key: string, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    }
}

/** Jev's endpoint for a provider: `/api/v1` becomes `/api/alpha/decisions` on the same host. */
export function decisionsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/alpha/decisions`;
}

/** A value nested in parsed JSON, or undefined at the first step that is not an object. */
function dig(value: unknown, ...path: (string | number)[]): unknown {
    let at = value;
    for (const key of path) {
        if (at === null || typeof at !== "object") return undefined;
        at = Reflect.get(at, key);
    }
    return at;
}

function cost(body: unknown): number | undefined {
    const value = dig(body, "usage", "cost");
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retryAfterMs(res: Response): number | undefined {
    const raw = res.headers.get("retry-after");
    if (!raw) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 10) * 1000 : undefined;
}

export function createModelClient(options: ModelClientOptions = {}): ModelClient {
    const doFetch = options.fetch ?? fetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const attempts = options.attempts ?? 4;
    const timeoutMs = options.timeoutMs ?? 45_000;
    const decisions = new Lru<Decided>(500);
    const descriptions = new Lru<Described>(8);

    async function post(provider: ModelProvider, url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
        let last: ModelError | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
            let res: Response;
            try {
                res = await doFetch(url, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${provider.apiKey}`,
                        "content-type": "application/json",
                        "x-title": "PiKVM screen watch",
                    },
                    body: JSON.stringify(body),
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                last = new ModelError(`The model service could not be reached: ${error instanceof Error ? error.message : String(error)}`, "network");
                if (attempt < attempts - 1) await sleep(backoff(attempt));
                continue;
            }
            if (res.status === 401 || res.status === 403) {
                throw new ModelError("OpenRouter refused the key. Check the key in Settings, Providers.", "auth", res.status);
            }
            if (res.status === 429 || res.status >= 500) {
                last = new ModelError(`OpenRouter answered ${res.status}.`, "http", res.status);
                if (attempt < attempts - 1) await sleep(retryAfterMs(res) ?? backoff(attempt));
                continue;
            }
            if (!res.ok) {
                // A service that echoes the request back must not put the key into an error that reaches a log.
                const detail = await res.text().then((t) => t.split(provider.apiKey).join("[key]").slice(0, 200)).catch(() => "");
                throw new ModelError(`OpenRouter answered ${res.status}${detail ? `: ${detail}` : ""}`, "http", res.status);
            }
            try {
                return await res.json();
            } catch {
                throw new ModelError("OpenRouter sent a reply that is not JSON.", "shape", res.status);
            }
        }
        throw last ?? new ModelError("The model call failed.", "network");
    }

    async function describeWith(
        kind: "screen" | "alert",
        provider: ModelProvider,
        model: string,
        jpeg: Buffer,
        signal: AbortSignal | undefined,
    ): Promise<Described> {
        const key = `${kind}:${model}:${sha(jpeg)}`;
        const hit = descriptions.get(key);
        if (hit) return { ...hit, cached: true };
        const body = await post(
            provider,
            `${provider.baseUrl}/chat/completions`,
            {
                model,
                max_tokens: 300,
                temperature: 0,
                usage: { include: true },
                messages: [
                    { role: "system", content: kind === "alert" ? ALERT_PROMPT : DESCRIBE_PROMPT },
                    {
                        role: "user",
                        content: [
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
                            { type: "text", text: kind === "alert" ? "Read this corner of the screen." : "Describe this screen." },
                        ],
                    },
                ],
            },
            signal,
        );
        const content = dig(body, "choices", 0, "message", "content");
        const raw = Array.isArray(content)
            ? content.map((part: unknown) => dig(part, "text")).filter((t): t is string => typeof t === "string").join("")
            : content;
        const text = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim();
        if (text === "") throw new ModelError(`The image model ${model} gave no description.`, "shape");
        const result: Described = { text, ...(cost(body) !== undefined ? { costUsd: cost(body)! } : {}), cached: false };
        descriptions.set(key, result);
        return result;
    }

    return {
        describe: (provider, model, jpeg, signal) => describeWith("screen", provider, model, jpeg, signal),
        describeAlert: (provider, model, jpeg, signal) => describeWith("alert", provider, model, jpeg, signal),

        async decide(provider, input, signal) {
            const request = decisionRequest(input);
            const key = sha(JSON.stringify(request));
            const hit = decisions.get(key);
            if (hit) return { ...hit, cached: true };
            const body = await post(provider, decisionsUrl(provider.baseUrl), request, signal);
            const type = dig(body, "answers", "notify", "type");
            const noul = dig(body, "answers", "notify", "noul");
            if (type !== "noul" || typeof noul !== "number" || !(noul >= 0 && noul <= 1)) {
                throw new ModelError("Jev's answer was not the yes/no probability that was asked for.", "shape");
            }
            const result: Decided = {
                noul,
                verdict: verdictOf(noul),
                ...(cost(body) !== undefined ? { costUsd: cost(body)! } : {}),
                cached: false,
            };
            decisions.set(key, result);
            return result;
        },
    };
}

/** Act only on a decisive answer: at least `DECISIVE` is a yes, at most `1 - DECISIVE` a no, anything between is undecided. */
export function verdictOf(noul: number): Verdict {
    if (noul >= DECISIVE) return "yes";
    if (noul <= 1 - DECISIVE) return "no";
    return "undecided";
}

function backoff(attempt: number): number {
    return Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
}
