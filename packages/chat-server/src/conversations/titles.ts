/**
 * Generated chat titles. The agent runtime names sessions only in its interactive mode (it forces PI_NO_TITLE in RPC
 * mode), so the server writes the title itself: the moment a prompt reaches an untitled chat, one small model call
 * turns the user's message into a 2-6 word title. The call runs beside the agent run (it does not wait for the
 * reply and never delays it) and has its own timeout.
 *
 * The model is the Small tasks role (`tiny`, see pickModel); there is no title-only model setting.
 *
 * The call takes the same path the agent takes to the provider: the gateway, with the gateway token, so the real
 * key stays in the gateway.
 *
 * Rules: only while `titleSource` is "auto" and the title is empty; off with `agent.titleGeneration`. Trivial
 * messages (greetings, under 3 words) are skipped and the next turn tries again. A failed call is retried on the
 * next turn, at most MAX_FAILURES times per chat.
 */
import type { AgenticChange } from "@pikvm/chat-protocol";
import { setTimeout as sleep } from "node:timers/promises";
import { chatTarget, postJson } from "../models/provider-call.ts";
import { resolveModelRole } from "../models/roles.ts";
import { setting } from "../settings/store.ts";
import { splitUserText } from "./history.ts";
import { getConversation, updateConversation, type ConversationRow } from "./service.ts";

const MAX_FAILURES = 2;
const CALL_TIMEOUT_MS = 20_000;
const MAX_TITLE_CHARS = 80;

export const TITLE_INSTRUCTIONS =
    "You write short titles for chat conversations. Reply with the title only: 2 to 6 words, in sentence case. " +
    "Write the title in the same language the user wrote their message in. Never translate: an English message " +
    "gets an English title, a French message a French title. No quotes, no trailing punctuation, no emoji, no " +
    "prefix such as 'Title:'.";

const inflight = new Set<string>();
const failures = new Map<string, number>();

const GREETING_WORDS = new Set(
    "hi hello hey hiya yo howdy hallo hola bonjour ciao sup good morning afternoon evening day there all everyone thanks thank you ok okay test testing ping how are what's whats up".split(
        " ",
    ),
);

/** Too little to name the chat: under 3 words, or only greeting words. */
export function isTrivial(text: string): boolean {
    const words = text
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}']/gu, ""))
        .filter(Boolean);
    return words.length < 3 || words.every((w) => GREETING_WORDS.has(w));
}

/** Clean what the model returned: one line, no wrapping quotes, prefix, emoji or end punctuation. */
export function cleanTitle(raw: string): string {
    let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
    t =
        t
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean) ?? "";
    t = t.replace(/^(?:#+\s*|\*\*|title\s*[:\-]\s*|chat title\s*[:\-]\s*)/i, "");
    t = t.replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "");
    t = t.replace(/[*_`]/g, "");
    t = t.replace(/^["'‘’“”«»\s]+|["'‘’“”«»\s]+$/g, "");
    t = t
        .replace(/[\s.!?;:,。]+$/u, "")
        .replace(/\s+/g, " ")
        .trim();
    if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, "");
    return t;
}

export interface Target {
    provider: string;
    model: string;
}

/**
 * The Small tasks role (`tiny`): its own model, else Fast, else the default model, else the chat's model, skipping any
 * the provider switches turn off (models/roles.ts).
 */
function pickModel(userId: string, chatModel: string): Target | undefined {
    const id = resolveModelRole(userId, "tiny", { chatModel }).model;
    const i = id?.indexOf("/") ?? -1;
    return id && i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : undefined;
}

const MODEL_WAIT_MS = 15_000;
const MODEL_POLL_MS = 100;

/**
 * The chat's own model, for a first prompt on an instance with no default model: the runtime picks it when the session
 * starts, a moment after the prompt arrives. Naming starts at the prompt and waits here, beside the run, until the
 * model is stored or MODEL_WAIT_MS has passed. Empty when it never appears.
 */
async function waitForChatModel(userId: string, conversationId: string): Promise<string> {
    const deadline = Date.now() + MODEL_WAIT_MS;
    while (Date.now() < deadline) {
        const model = getConversation(userId, conversationId).model?.trim();
        if (model) return model;
        await sleep(MODEL_POLL_MS);
    }
    return "";
}

/**
 * One non-streaming completion in the provider's API family. Undefined for families not handled here. Also used by
 * the agent builder (agents/builder.ts), which needs the same path to the provider.
 */
export async function complete(
    userId: string,
    t: Target,
    system: string,
    user: string,
    maxTokens = 64,
    options: { disableReasoning?: boolean; json?: boolean; timeoutMs?: number } = {},
): Promise<string | undefined> {
    const target = chatTarget(userId, t.provider);
    if (!target) return undefined;
    const { api } = target;
    // Provider reply shapes differ by API family; read defensively below.
    const post = async (path: string, body: unknown, extra: Record<string, string> = {}) =>
        (await postJson(target, path, body, AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS), extra)) as any;
    switch (api) {
        case "openai-completions": {
            const r = await post("/chat/completions", {
                model: t.model,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                max_tokens: maxTokens,
                stream: false,
                // OpenRouter can spend the small naming budget on reasoning instead of visible text.
                ...(options.disableReasoning && t.provider === "openrouter" ? { reasoning: { enabled: false } } : {}),
                // JSON mode: the endpoint then answers with one JSON object only (the messages must say "JSON").
                ...(options.json ? { response_format: { type: "json_object" } } : {}),
            });
            return r?.choices?.[0]?.message?.content ?? "";
        }
        case "openai-responses": {
            const r = await post("/responses", {
                model: t.model,
                instructions: system,
                input: user,
                max_output_tokens: maxTokens,
                store: false,
                ...(options.json ? { text: { format: { type: "json_object" } } } : {}),
            });
            if (typeof r?.output_text === "string") return r.output_text;
            return (r?.output ?? [])
                .flatMap((o: any) => o?.content ?? [])
                .map((c: any) => c?.text ?? "")
                .join("");
        }
        case "anthropic-messages": {
            const r = await post(
                "/v1/messages",
                { model: t.model, system, messages: [{ role: "user", content: user }], max_tokens: maxTokens },
                { "anthropic-version": "2023-06-01" },
            );
            return (r?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join("");
        }
        case "google-generative-ai": {
            const r = await post(`/models/${encodeURIComponent(t.model)}:generateContent`, {
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: "user", parts: [{ text: user }] }],
                generationConfig: { maxOutputTokens: maxTokens, ...(options.json ? { responseMimeType: "application/json" } : {}) },
            });
            return (r?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
        }
        default:
            return undefined;
    }
}

/** Eligible for a generated title right now. Re-checked just before saving, as the user may rename meanwhile. */
function wantsTitle(row: ConversationRow): boolean {
    return row.titleSource === "auto" && !row.title;
}

export interface TitleRequest {
    userId: string;
    conversationId: string;
    /** The user's message as sent to the agent (hidden notes are stripped here). */
    message: string;
    /** Tell the agent runtime the session's name, once there is a title. Best effort. */
    rename: (name: string) => Promise<unknown>;
    /** Broadcast the updated conversation, naming the fields this call changed. */
    updated: (changed: AgenticChange) => void;
}

/**
 * Name the chat from the user's message. Meant to be started without `await` beside the run. Never throws and has
 * its own timeout (CALL_TIMEOUT_MS).
 */
export async function maybeGenerateTitle(r: TitleRequest): Promise<void> {
    const { userId, conversationId } = r;
    if (inflight.has(conversationId)) return;
    try {
        if ((failures.get(conversationId) ?? 0) >= MAX_FAILURES) return;
        const row = getConversation(userId, conversationId);
        const text = splitUserText(r.message).text.trim();
        // A slash command is answered by the runtime itself: it says nothing about the chat's subject.
        const trivial = !text || text.startsWith("/") || isTrivial(text);
        if (!setting("agent.titleGeneration", userId) || !wantsTitle(row) || trivial) return;
        inflight.add(conversationId);
        let target = pickModel(userId, row.model);
        if (!target && !row.model.trim()) target = pickModel(userId, await waitForChatModel(userId, conversationId));
        const raw = target
            ? await complete(userId, target, TITLE_INSTRUCTIONS, `User message:\n${text.slice(0, 1500)}`, 64, {
                  disableReasoning: true,
              })
            : undefined;
        if (raw === undefined) {
            // No model, or an API family without a client here: titles stop for this chat.
            if (target) {
                console.warn(`[titles] ${conversationId}: no title client for ${target.provider}`);
                failures.set(conversationId, MAX_FAILURES);
            }
            return;
        }
        const title = cleanTitle(raw);
        if (!title) throw new Error("the model returned an empty title");
        failures.delete(conversationId);
        // Re-check just before saving: the user may have renamed the chat meanwhile.
        if (!wantsTitle(getConversation(userId, conversationId))) return;
        updateConversation(userId, conversationId, { title, titleSource: "auto" });
        r.updated({ title: true });
        await r.rename(title).catch(() => undefined);
    } catch (err) {
        failures.set(conversationId, (failures.get(conversationId) ?? 0) + 1);
        console.warn(`[titles] ${conversationId}: ${(err as Error).message}`);
    } finally {
        inflight.delete(conversationId);
    }
}
