/**
 * Questions from the agent: the runtime's dialog requests (`ask`, and `select`/`confirm`/`input`/`editor`
 * from extensions) as `chat.ask_request` items, the client's `chat.ask_response` as the runtime's
 * answer, and the same record rebuilt from a session file.
 *
 * Skipping: a cancelled `ask` makes the runtime abort the whole turn, so a skipped question is sent as
 * free text (`SKIPPED_ANSWER_TEXT`) and the agent continues. Stopping the run is the only path that
 * cancels a question. The other dialog kinds have no free text, so a skip cancels them (the runtime
 * then takes its default: no value, or "no" for a confirm).
 */
import {
    SKIPPED_ANSWER_TEXT,
    type AskRequestItem,
    type AskResponseItem,
    type Question,
    type QuestionAnswer,
    type QuestionOutcome,
} from "@pikvm/chat-protocol";
import type { UiAnswer, UiRequest } from "./rpc.ts";

/** A `cancel` from the runtime this close to the deadline is the runtime's own timeout. */
const TIMEOUT_TOLERANCE_MS = 1500;

const CONFIRM_OPTIONS = [{ label: "Yes" }, { label: "No" }];

/** The item for one dialog request. `callId`: the `ask` tool call that opened it, if known. */
export function questionItem(req: UiRequest, callId?: string): AskRequestItem {
    const title = req.title ?? "";
    const base = {
        id: `ask_${req.id}`,
        type: "chat.ask_request" as const,
        status: "in_progress" as const,
        ...(req.timeout ? { timeout_ms: req.timeout, expires_at: Date.now() + req.timeout } : {}),
        ...(callId ? { call_id: callId } : {}),
    };
    switch (req.method) {
        case "ask":
            return {
                ...base,
                kind: "ask",
                allow_free_text: true,
                questions: (req.questions ?? []).map((q) => ({
                    id: q.id,
                    question: q.question,
                    options: q.options.map((o) => ({ label: o.label, description: o.description, preview: o.preview })),
                    ...(q.header ? { header: q.header } : {}),
                    ...(q.multi ? { multi: true } : {}),
                    ...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
                })),
            };
        case "select":
            return {
                ...base,
                kind: "select",
                allow_free_text: false,
                questions: [
                    {
                        id: "select",
                        question: title,
                        options: (req.options ?? []).map((label, i) => ({ label, description: req.optionDetails?.[i]?.description })),
                    },
                ],
            };
        case "confirm":
            return {
                ...base,
                kind: "confirm",
                allow_free_text: false,
                message: req.message,
                questions: [{ id: "confirm", question: title, options: CONFIRM_OPTIONS }],
            };
        case "input":
        case "editor":
            return {
                ...base,
                kind: req.method,
                allow_free_text: true,
                ...(req.placeholder ? { placeholder: req.placeholder } : {}),
                ...(req.prefill ? { prefill: req.prefill } : {}),
                questions: [{ id: req.method, question: title, options: [] }],
            };
    }
}

export interface Settled {
    /** What goes back to the runtime. */
    answer: UiAnswer;
    /** What the item records. */
    answers: QuestionAnswer[];
    outcome: QuestionOutcome;
}

const skipped = (q: Question): QuestionAnswer => ({ id: q.id, selected: [], skipped: true });

/** Validate one answer against its question. Returns undefined when it is not a valid answer. */
function cleanAnswer(q: Question, a: QuestionAnswer | undefined, freeText: boolean): QuestionAnswer | undefined {
    if (!a || a.skipped) return skipped(q);
    const labels = new Set(q.options.map((o) => o.label));
    const selected = [...new Set(a.selected ?? [])];
    if (selected.some((l) => !labels.has(l))) return undefined;
    const text = freeText ? a.text?.trim() || undefined : undefined;
    if (!selected.length && !text) return skipped(q);
    // Single choice: free text replaces a picked option (the runtime accepts only one of the two).
    if (!q.multi) return text ? { id: q.id, selected: [], text } : { id: q.id, selected: selected.slice(0, 1) };
    return { id: q.id, selected, ...(text ? { text } : {}) };
}

/** Turn the client's response into the runtime's answer. Undefined when the response is invalid. */
export function settleFromResponse(item: AskRequestItem, r: AskResponseItem): Settled | undefined {
    const given = r.answers ?? [];
    const answers: QuestionAnswer[] = [];
    for (const q of item.questions) {
        const a = given.find((x) => x.id === q.id);
        const clean = r.skip && !a ? skipped(q) : cleanAnswer(q, a, item.allow_free_text);
        if (!clean) return undefined;
        answers.push(clean);
    }
    const allSkipped = answers.every((a) => a.skipped);
    const outcome: QuestionOutcome = allSkipped ? "skipped" : "answered";
    if (item.kind === "ask") {
        return {
            outcome,
            answers,
            answer: {
                answers: answers.map((a) =>
                    a.skipped
                        ? { id: a.id, selectedOptions: [], customInput: SKIPPED_ANSWER_TEXT }
                        : { id: a.id, selectedOptions: a.selected, ...(a.text ? { customInput: a.text } : {}) },
                ),
            },
        };
    }
    const a = answers[0]!;
    if (allSkipped) return { outcome, answers, answer: { cancelled: true } };
    if (item.kind === "confirm") return { outcome, answers, answer: { confirmed: a.selected[0] === "Yes" } };
    return { outcome, answers, answer: { value: a.text ?? a.selected[0] ?? "" } };
}

/** The answers the runtime picks itself on timeout: the recommended option (or the first) of each question. */
export function timedOutAnswers(item: AskRequestItem): QuestionAnswer[] {
    return item.questions.map((q) => {
        const i = Math.min(Math.max(q.recommended ?? 0, 0), Math.max(q.options.length - 1, 0));
        const label = item.kind === "ask" ? q.options[i]?.label : undefined;
        return { id: q.id, selected: label ? [label] : [], timed_out: true };
    });
}

/** The runtime closed the dialog itself: its timeout, or the run was aborted. */
export function closedByRuntime(item: AskRequestItem): { outcome: "timed_out" | "cancelled"; answers?: QuestionAnswer[] } {
    const timedOut = item.expires_at !== undefined && Date.now() >= item.expires_at - TIMEOUT_TOLERANCE_MS;
    return timedOut ? { outcome: "timed_out", answers: timedOutAnswers(item) } : { outcome: "cancelled" };
}

interface AskResultDetails {
    question?: string;
    options?: string[];
    multi?: boolean;
    selectedOptions?: string[];
    customInput?: string;
    timedOut?: boolean;
    results?: (AskResultDetails & { id: string })[];
}

interface AskArgs {
    questions?: Question[];
}

/** Rebuild one answer from the runtime's stored result. */
function answerFromResult(id: string, r: AskResultDetails): QuestionAnswer {
    if (r.customInput === SKIPPED_ANSWER_TEXT) return { id, selected: [], skipped: true };
    return {
        id,
        selected: r.selectedOptions ?? [],
        ...(r.customInput !== undefined ? { text: r.customInput } : {}),
        ...(r.timedOut ? { timed_out: true } : {}),
    };
}

/**
 * The question record for a finished `ask` tool call in a session file: the questions come from the
 * call's arguments, the answers from the result's details. An error result (the run was stopped, or
 * the dialog was cancelled) records the questions as cancelled.
 */
export function askRecord(id: string, callId: string, argsJson: string, details: unknown, isError: boolean): AskRequestItem {
    let args: AskArgs = {};
    try {
        args = JSON.parse(argsJson) as AskArgs;
    } catch {}
    const d = (details ?? {}) as AskResultDetails;
    const fromDetails: Question[] = (d.results ?? (d.question ? [{ ...d, id: "q1" }] : [])).map((r) => ({
        id: r.id,
        question: r.question ?? "",
        options: (r.options ?? []).map((label) => ({ label })),
        ...(r.multi ? { multi: true } : {}),
    }));
    const questions = Array.isArray(args.questions) && args.questions.length ? args.questions : fromDetails;
    const item: AskRequestItem = {
        id,
        type: "chat.ask_request",
        status: "completed",
        kind: "ask",
        allow_free_text: true,
        questions,
        call_id: callId,
    };
    const results = d.results ?? (d.selectedOptions || d.customInput !== undefined ? [{ ...d, id: questions[0]?.id ?? "q1" }] : []);
    if (isError || !results.length) return { ...item, outcome: "cancelled" };
    const answers = questions.map((q, i) => answerFromResult(q.id, results.find((r) => r.id === q.id) ?? results[i] ?? {}));
    const outcome: QuestionOutcome = answers.every((a) => a.skipped)
        ? "skipped"
        : answers.some((a) => a.timed_out)
          ? "timed_out"
          : "answered";
    return { ...item, outcome, answers };
}
