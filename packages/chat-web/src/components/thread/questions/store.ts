/**
 * Open questions from the assistant: which ones the user already answered here (so the tray closes at
 * once), the draft of a question with several steps (shared by the tray and the composer, which can
 * answer the current step in free text), and sending the answer.
 */
import type { AskRequestItem, AskResponseItem, QuestionAnswer, ServerEvent } from "@pikvm/chat-protocol";
import { useSyncExternalStore } from "react";
import { useLive } from "../../../lib/live";
import { socket } from "../../../lib/socket";
import { registerSessionReset } from "../../../lib/session-reset";

export interface Draft {
    /** Index of the question on screen. */
    step: number;
    /** Answers so far, by question index. */
    answers: (QuestionAnswer | undefined)[];
}

/** Item id -> conversation id of every answer sent and not rejected. */
const sent = new Map<string, string>();
const drafts = new Map<string, Draft>();
const subs = new Set<() => void>();
let version = 0;
let accountGeneration = 0;

/** Remove account-owned question state without removing mounted subscriptions. */
export function resetQuestions(): void {
    accountGeneration++;
    sent.clear();
    drafts.clear();
    lastSent = undefined;
    bump();
}

const unregisterSessionReset = registerSessionReset("questions", resetQuestions);
import.meta.hot?.dispose(unregisterSessionReset);

function bump() {
    version++;
    for (const fn of subs) fn();
}

function subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
}

// An answer the server rejects (it does not fit the question) reopens the question here.
let lastSent: string | undefined;
socket.on((e: ServerEvent) => {
    if (e.type === "error" && e.error.code === "invalid_answer" && lastSent && sent.delete(lastSent)) bump();
});

export function useQuestionsVersion(): number {
    return useSyncExternalStore(subscribe, () => version);
}

/** Questions of the running response that are still open, oldest first. */
export function useOpenQuestions(conversationId: string | undefined): AskRequestItem[] {
    const live = useLive(conversationId);
    useQuestionsVersion();
    if (!live || live.done) return [];
    return live.response.output.filter(
        (i): i is AskRequestItem => i.type === "chat.ask_request" && i.status === "in_progress" && !sent.has(i.id),
    );
}

export function getDraft(item: AskRequestItem): Draft {
    let d = drafts.get(item.id);
    if (!d) drafts.set(item.id, (d = { step: 0, answers: [] }));
    return d;
}

export function setDraft(item: AskRequestItem, d: Draft): void {
    drafts.set(item.id, d);
    bump();
}

/** Send the response once. */
export function respond(
    conversationId: string,
    item: AskRequestItem,
    body: Omit<AskResponseItem, "type" | "ask_request_id">,
): void {
    if (sent.has(item.id)) return;
    sent.set(item.id, conversationId);
    lastSent = item.id;
    drafts.delete(item.id);
    bump();
    socket.send({
        type: "response.create",
        conversation: conversationId,
        input: [{ type: "chat.ask_response", ask_request_id: item.id, ...body }],
    });
}

/**
 * Record the answer to the current step. Moves to the next unanswered step, or sends everything once
 * the last step has an answer. Returns true when the response was sent.
 */
export function answerStep(conversationId: string, item: AskRequestItem, answer: QuestionAnswer): boolean {
    const d = getDraft(item);
    const answers = [...d.answers];
    answers[d.step] = answer;
    const next = item.questions.findIndex((_, i) => i > d.step && !answers[i]);
    if (next >= 0) {
        setDraft(item, { step: next, answers });
        return false;
    }
    const firstMissing = item.questions.findIndex((_, i) => !answers[i]);
    if (firstMissing >= 0) {
        setDraft(item, { step: firstMissing, answers });
        return false;
    }
    respond(conversationId, item, { answers: answers as QuestionAnswer[] });
    return true;
}

/** Skip every question not answered yet; the assistant continues without them. */
export function skipRest(conversationId: string, item: AskRequestItem): void {
    const d = getDraft(item);
    const answers = item.questions.flatMap((_, i) => (d.answers[i] ? [d.answers[i]!] : []));
    respond(conversationId, item, { skip: true, answers });
}

/**
 * For the composer: while a question that takes free text is open, the composer answers its current
 * step. Undefined when no such question is open.
 */
export function useQuestionReply(
    conversationId: string | undefined,
): { placeholder: string; reply: (text: string) => void } | undefined {
    const open = useOpenQuestions(conversationId);
    const item = open[0];
    if (!conversationId || !item || !item.allow_free_text) return undefined;
    const generation = accountGeneration;
    return {
        placeholder: "Or reply directly…",
        reply: (text) => {
            if (generation !== accountGeneration) return;
            const q = item.questions[getDraft(item).step];
            if (q && text.trim()) answerStep(conversationId, item, { id: q.id, selected: [], text: text.trim() });
        },
    };
}
