import { createHash, randomUUID } from "node:crypto";
import { DeskError, type ApprovalDecision, type ApprovalRequest, type Approver } from "@pikvm/mcp";
import type { PendingApproval } from "@pikvm/contracts/api";

/**
 * The approvals of outside MCP clients, waiting for a person.
 *
 * Chat asks in the conversation whose call it is. A client outside the app (Claude Code, Codex, Executor) has no
 * conversation, so its risky calls wait here, first in, first out, as a card on the KVM tab. The call is held open
 * until the person answers it. An answer decides that call and nothing else.
 *
 * If nobody answers within `holdMs` the call ends, refused, and its question goes with it. A client that repeats the
 * call asks again from the start: nothing is remembered, so an Allow cannot be used by a call the person never saw.
 * The same call repeated while its question still waits joins it, so the person sees one card.
 *
 * Answering needs a person signed in, and the server refuses an answer from a script's credentials (agent/routes.ts).
 */

import { EXTERNAL_PREFIX } from "@pikvm/contracts/api";
export { EXTERNAL_PREFIX };

/** How long a call waits for the person before it is refused. */
export const APPROVAL_HOLD_MS = 90_000;
/** A client cannot bury the person in questions. */
export const MAX_WAITING = 20;

export interface ApprovalFeed {
    pending(): readonly PendingApproval[];
    /** Told the whole list again after every change; returns how to stop. */
    subscribe(listener: (pending: readonly PendingApproval[]) => void): () => void;
}

export interface ApprovalQueue extends ApprovalFeed, Approver {
    /** The person's answer. False when the question is not waiting any more (answered, timed out or cleared). */
    answer(id: string, decision: "approved" | "denied"): boolean;
    /** The person pressed Stop: every waiting question is dropped and its calls are refused. */
    clear(): void;
}

export interface ApprovalQueueOptions {
    holdMs?: number;
    now?: () => number;
    /** Test seam: run `fn` after `ms` and return how to cancel it. Default: a timer that does not keep the process alive. */
    after?: (fn: () => void, ms: number) => () => void;
    /** A question has just started to wait: the host may tell the person. */
    onWaiting?: (approval: PendingApproval) => void;
}

/** The same value, whatever order its keys came in. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** One call, by client, tool and arguments, so a repeat that arrives while it waits can join it. */
function fingerprint(request: ApprovalRequest): string {
    return createHash("sha256").update(canonical([request.conversationId, request.tool, request.arguments])).digest("hex");
}

interface Entry {
    readonly view: PendingApproval;
    readonly key: string;
    /** One per call held on this question. */
    readonly waiters: Set<(decision: ApprovalDecision) => void>;
}

const TIMED_OUT =
    "The person did not answer in time, so it was not done. Tell them what you wanted to do and ask them; repeat the call when they say yes and they will be asked again.";

export function createApprovalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
    const holdMs = options.holdMs ?? APPROVAL_HOLD_MS;
    const now = options.now ?? Date.now;
    const after =
        options.after ??
        ((fn: () => void, ms: number) => {
            const timer = setTimeout(fn, ms);
            timer.unref();
            return () => clearTimeout(timer);
        });
    /** In the order they asked: a Map keeps insertion order. */
    const waiting = new Map<string, Entry>();
    const listeners = new Set<(pending: readonly PendingApproval[]) => void>();

    const list = (): readonly PendingApproval[] => [...waiting.values()].map((entry) => entry.view);
    const publish = (): void => {
        const current = list();
        for (const listener of [...listeners]) listener(current);
    };

    /** Drop the question and tell every call held on it. */
    function close(entry: Entry, decision: ApprovalDecision): void {
        if (!waiting.delete(entry.view.id)) return;
        for (const settle of [...entry.waiters]) settle(decision);
        publish();
    }

    return {
        pending: list,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        ask(request) {
            if (request.signal.aborted) return Promise.resolve("unavailable");
            const key = fingerprint(request);
            let entry = [...waiting.values()].find((candidate) => candidate.key === key);
            if (!entry) {
                if (waiting.size >= MAX_WAITING) return Promise.resolve("unavailable");
                const at = now();
                const view: PendingApproval = {
                    id: randomUUID(),
                    client: request.conversationId.startsWith(EXTERNAL_PREFIX) ? request.conversationId.slice(EXTERNAL_PREFIX.length) : request.conversationId,
                    tool: request.tool,
                    title: request.title,
                    summary: request.summary,
                    reasons: request.reasons,
                    at,
                    expiresAt: at + holdMs,
                };
                entry = { view, key, waiters: new Set() };
                waiting.set(view.id, entry);
                publish();
                try {
                    options.onWaiting?.(view);
                } catch {
                    /* telling the person is a courtesy; the question still waits */
                }
            }

            const held = entry;
            const { promise, resolve, reject } = Promise.withResolvers<ApprovalDecision>();
            let cancelHold: () => void = () => {};
            /** This call stops waiting, whichever way it ends. */
            const leave = (): void => {
                held.waiters.delete(settle);
                request.signal.removeEventListener("abort", onAbort);
                cancelHold();
            };
            /** The question goes when no call is left on it: nobody is waiting for its answer, so an Allow would decide nothing. */
            const dropIfAbandoned = (): void => {
                if (held.waiters.size === 0 && waiting.delete(held.view.id)) publish();
            };
            /** The person answered, or Stop was pressed: the question is already gone. */
            function settle(decision: ApprovalDecision): void {
                leave();
                resolve(decision);
            }
            const onAbort = (): void => {
                leave();
                dropIfAbandoned();
                resolve("unavailable");
            };
            held.waiters.add(settle);
            request.signal.addEventListener("abort", onAbort, { once: true });
            cancelHold = after(() => {
                leave();
                dropIfAbandoned();
                reject(new DeskError("approval_denied", TIMED_OUT));
            }, holdMs);
            return promise;
        },
        answer(id, decision) {
            const entry = waiting.get(id);
            if (!entry) return false;
            close(entry, decision);
            return true;
        },
        clear() {
            for (const entry of [...waiting.values()]) close(entry, "unavailable");
        },
    };
}
