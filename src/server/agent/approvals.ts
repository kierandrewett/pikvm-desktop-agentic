import { createHash, randomUUID } from "node:crypto";
import { DeskError, type ApprovalDecision, type ApprovalRequest, type Approver } from "@pikvm/mcp";
import type { PendingApproval } from "@pikvm/contracts/api";

/**
 * The approvals of outside MCP clients, waiting for a person.
 *
 * Chat asks in the conversation whose call it is. A client outside the app (Claude Code, Codex, Executor) has no
 * conversation, so its risky calls wait here, as a card on the KVM tab and at a link the client is given.
 *
 * How a call goes:
 *  1. The call is held open for `holdMs`. A person who is looking answers on the KVM tab and the call goes on.
 *  2. Past that the call ends with the link, and the question stays waiting for `ttlMs`. Opening the link (signed in)
 *     shows the same card. Allowing it grants that exact call, once, for `grantMs`: the client repeats it and it goes
 *     through. This is what a client that cannot wait does, and what a person who was away does.
 *  3. A call with other arguments, from another client, or after the grant, asks again.
 *
 * The link names a question; it carries no authority. Answering needs a person signed in, and the server refuses an
 * answer from a script's credentials (agent/routes.ts). Only a hash of what was asked is kept for a grant.
 */

/** The conversation id of an outside client's control session: this and the name it signed in under. Chat's own ids never start so. */
export const EXTERNAL_PREFIX = "mcp-";

/** How long a call waits for an answer before it returns the link. */
export const APPROVAL_HOLD_MS = 30_000;
/** How long a question stays on the KVM tab and at its link. */
export const APPROVAL_TTL_MS = 10 * 60_000;
/** How long an allowed call may be repeated, once. */
export const APPROVAL_GRANT_MS = 5 * 60_000;
/** A client cannot bury the person in questions. */
export const MAX_WAITING = 20;

export interface ApprovalFeed {
    pending(): readonly PendingApproval[];
    /** Told the whole list again after every change; returns how to stop. */
    subscribe(listener: (pending: readonly PendingApproval[]) => void): () => void;
}

export interface ApprovalQueue extends ApprovalFeed, Approver {
    /** The person's answer. False when the question is not waiting any more (answered, expired or cleared). */
    answer(id: string, decision: "approved" | "denied"): boolean;
    /** The person pressed Stop: every waiting question is dropped, and every allowance not yet used is forgotten. */
    clear(): void;
}

export interface ApprovalQueueOptions {
    holdMs?: number;
    ttlMs?: number;
    grantMs?: number;
    now?: () => number;
    /** Test seam: run `fn` after `ms` and return how to cancel it. Default: a timer that does not keep the process alive. */
    after?: (fn: () => void, ms: number) => () => void;
    /** A question has just started to wait: the host may tell the person. */
    onWaiting?: (approval: PendingApproval) => void;
    /** Where the person answers one question, in a browser. Undefined when the host has no address to give (the desktop app). */
    link?: (id: string) => string | undefined;
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

/** One call, by client, tool and arguments. A hash: what was typed is not kept. */
function fingerprint(request: ApprovalRequest): string {
    return createHash("sha256").update(canonical([request.conversationId, request.tool, request.arguments])).digest("hex");
}

interface Entry {
    readonly view: PendingApproval;
    readonly key: string;
    readonly waiters: Set<(decision: ApprovalDecision) => void>;
    cancelTtl(): void;
}

export function createApprovalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
    const holdMs = options.holdMs ?? APPROVAL_HOLD_MS;
    const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
    const grantMs = options.grantMs ?? APPROVAL_GRANT_MS;
    const now = options.now ?? Date.now;
    const after =
        options.after ??
        ((fn: () => void, ms: number) => {
            const timer = setTimeout(fn, ms);
            timer.unref();
            return () => clearTimeout(timer);
        });
    const waiting = new Map<string, Entry>();
    /** Allowed calls not yet repeated: fingerprint to the time the allowance ends. */
    const grants = new Map<string, number>();
    const listeners = new Set<(pending: readonly PendingApproval[]) => void>();

    const list = (): readonly PendingApproval[] => [...waiting.values()].map((entry) => entry.view);
    const publish = (): void => {
        const current = list();
        for (const listener of [...listeners]) listener(current);
    };

    /** Drop the question, tell the calls still held on it, and say whether any were. */
    function close(entry: Entry, decision: ApprovalDecision): boolean {
        if (!waiting.delete(entry.view.id)) return false;
        entry.cancelTtl();
        const held = [...entry.waiters];
        for (const settle of held) settle(decision);
        publish();
        return held.length > 0;
    }

    function sweepGrants(): void {
        const at = now();
        for (const [key, until] of grants) if (until <= at) grants.delete(key);
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
            sweepGrants();
            if (grants.delete(key)) return Promise.resolve("approved");

            // The same call, repeated while its question still waits, joins it: the person sees one card.
            let entry = [...waiting.values()].find((candidate) => candidate.key === key);
            if (!entry) {
                if (waiting.size >= MAX_WAITING) return Promise.resolve("unavailable");
                const id = randomUUID();
                const at = now();
                const view: PendingApproval = {
                    id,
                    client: request.conversationId.startsWith(EXTERNAL_PREFIX) ? request.conversationId.slice(EXTERNAL_PREFIX.length) : request.conversationId,
                    tool: request.tool,
                    title: request.title,
                    summary: request.summary,
                    reasons: request.reasons,
                    at,
                    expiresAt: at + ttlMs,
                };
                const made: Entry = { view, key, waiters: new Set(), cancelTtl: () => {} };
                made.cancelTtl = after(() => void close(made, "unavailable"), ttlMs);
                waiting.set(id, made);
                entry = made;
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
            const release = (): void => {
                held.waiters.delete(settle);
                request.signal.removeEventListener("abort", onAbort);
                cancelHold();
            };
            function settle(decision: ApprovalDecision): void {
                release();
                resolve(decision);
            }
            // A client that went away leaves its question waiting: the person may still allow it, and the client repeats the call.
            const onAbort = (): void => settle("unavailable");
            held.waiters.add(settle);
            request.signal.addEventListener("abort", onAbort, { once: true });
            cancelHold = after(() => {
                release();
                const link = options.link?.(held.view.id);
                reject(
                    new DeskError(
                        "approval_denied",
                        (link
                            ? `The person has not answered yet. Ask them to open ${link} and allow it, `
                            : "The person has not answered yet. Ask them to allow it on the KVM tab of the PiKVM app, ") +
                            `then repeat this exact call, with the same arguments, within ${Math.round(grantMs / 60_000)} minutes. Do not change it.`,
                    ),
                );
            }, holdMs);
            return promise;
        },
        answer(id, decision) {
            const entry = waiting.get(id);
            if (!entry) return false;
            // Nobody held on it: the call gave up, so what the person allowed is for the client's next try.
            const held = close(entry, decision);
            if (decision === "approved" && !held) grants.set(entry.key, now() + grantMs);
            return true;
        },
        clear() {
            grants.clear();
            for (const entry of [...waiting.values()]) close(entry, "unavailable");
        },
    };
}
