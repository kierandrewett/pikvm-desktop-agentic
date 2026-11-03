/**
 * Agent process slots and the wait queue for them.
 *
 * A new agent process needs a slot under the per-user limit (the same count: there is one user) and the global limit
 * (`system.agent.maxProcesses`). An idle process can give up its slot: the least recently used one is evicted.
 * When every slot is held by a running response, the request waits here instead of failing.
 *
 * Rules:
 * - First in, first out. When a slot frees, the oldest waiter that can use it gets it.
 * - A waiter blocked only by its own user's limit does not hold up other users: it is skipped, not dropped.
 * - A granted slot is a claim until the process is registered (`Slot.release`), so two grants never take the
 *   same free slot while one process is still starting.
 * - A wait ends in one of these ways: granted, aborted (stop, conversation deleted, account stopped, user gone)
 *   or timed out (`system.agent.queueTimeoutSec`). An abort rejects with `SlotAbort`, a timeout with `SlotTimeout`.
 * - The waiter's client hears its position through `host.announce`, and a `null` position when it leaves.
 *
 * This module does not know about conversations or processes. `sessions.ts` supplies them through `SlotHost`.
 */
import { setting } from "../settings/store.ts";

/** A live agent process, as the queue needs to see it. */
export interface SlotProcess {
    userId: string;
    conversationId: string;
    lastUsed: number;
    /** A response is running or starting on it: it cannot be evicted. */
    active: boolean;
}

export interface SlotHost {
    processes(): SlotProcess[];
    /** Stop the process of a conversation and wait until it has gone. */
    evict(conversationId: string): Promise<void>;
    /** Tell the user's clients where a conversation stands in the queue; `null` when it left the queue. */
    announce(userId: string, conversationId: string, position: number | null): void;
}

export type AbortReason = "stopped" | "deleted" | "account" | "disconnected";

/** The wait ended without a slot because the request is gone. */
export class SlotAbort extends Error {
    constructor(readonly reason: AbortReason) {
        super(`queue wait ended: ${reason}`);
    }
}

/** The wait ran past `system.agent.queueTimeoutSec`. `scope` names the limit that held the request back. */
export class SlotTimeout extends Error {
    constructor(
        readonly scope: "user" | "global",
        readonly max: number,
    ) {
        super(`no agent slot free (${scope} limit ${max})`);
    }
}

export interface Slot {
    /** The process is registered (or failed to start). Safe to call more than once. */
    release(): void;
}

interface Waiter {
    userId: string;
    conversationId: string;
    joinedAt: number;
    /** The position last sent to the client. */
    announced: number | null;
    /** The limit that blocked the latest attempt. */
    blocked?: { scope: "user" | "global"; max: number };
    attempted: boolean;
    attempting: boolean;
    /** The wait bound passed. Acted on after the current attempt, so an eviction in progress is not wasted. */
    expired: boolean;
    timer?: ReturnType<typeof setTimeout>;
    resolve(slot: Slot): void;
    reject(err: Error): void;
}

/** Without a client for this long, the user's queued requests are dropped. A reload reconnects well inside it. */
const DISCONNECT_GRACE_MS = 15_000;
/** How often waiters look again, so a raised limit takes effect without another event. */
const RECHECK_MS = 2000;

let host: SlotHost | undefined;
const waiting: Waiter[] = [];
const claims = new Set<{ userId: string }>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
let draining = false;
let again = false;

export function setSlotHost(h: SlotHost): void {
    host = h;
}

function need(): SlotHost {
    if (!host) throw new Error("[agent] slot host is not set");
    return host;
}

/** Wait for a slot for a new process of `userId`. Resolves at once when one is free or an idle process can go. */
export function acquireSlot(userId: string, conversationId: string): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
        const w: Waiter = {
            userId,
            conversationId,
            joinedAt: Date.now(),
            announced: null,
            attempted: false,
            attempting: false,
            expired: false,
            resolve,
            reject,
        };
        waiting.push(w);
        const seconds = setting("system.agent.queueTimeoutSec");
        // 0 turns the queue off: the first attempt decides.
        if (seconds === 0) w.expired = true;
        else
            w.timer = setTimeout(() => {
                w.expired = true;
                if (w.attempted && !w.attempting) fail(w);
            }, seconds * 1000);
        changed();
    });
}

/** Run the queue again: a process ended or went idle, a claim was released, or someone joined. */
export function changed(): void {
    void drain();
}

async function drain(): Promise<void> {
    if (draining) {
        again = true;
        return;
    }
    draining = true;
    try {
        do {
            again = false;
            for (const w of [...waiting]) {
                if (!waiting.includes(w)) continue;
                const granted = await attempt(w);
                if (!waiting.includes(w)) continue;
                if (granted) grant(w);
                else if (w.expired) fail(w);
            }
        } while (again);
    } catch (err) {
        console.error("[agent] slot queue failed", err);
    } finally {
        draining = false;
        announce();
    }
}

function claimsOf(userId: string): number {
    let n = 0;
    for (const c of claims) if (c.userId === userId) n++;
    return n;
}

const oldest = (list: SlotProcess[]) => list.sort((a, b) => a.lastUsed - b.lastUsed)[0];

/** True when `w` may start a process now. Evicts idle processes as needed; false when a limit holds. */
async function attempt(w: Waiter): Promise<boolean> {
    w.attempted = true;
    w.attempting = true;
    try {
        for (;;) {
            if (!waiting.includes(w)) return false;
            // One operator: the per-user limit is the global one.
            const global = setting("system.agent.maxProcesses");
            const perUser = global;
            const procs = need().processes();
            const mine = procs.filter((p) => p.userId === w.userId);
            const scope =
                mine.length + claimsOf(w.userId) >= perUser
                    ? "user"
                    : procs.length + claims.size >= global
                      ? "global"
                      : undefined;
            if (!scope) return true;
            const victim = oldest((scope === "user" ? mine : procs).filter((p) => !p.active));
            if (!victim) {
                w.blocked = { scope, max: scope === "user" ? perUser : global };
                return false;
            }
            await need().evict(victim.conversationId);
        }
    } finally {
        w.attempting = false;
    }
}

function grant(w: Waiter): void {
    const claim = { userId: w.userId };
    claims.add(claim);
    leave(w, "granted");
    w.resolve({
        release: () => {
            if (claims.delete(claim)) changed();
        },
    });
}

function fail(w: Waiter): void {
    if (!waiting.includes(w)) return;
    const b = w.blocked ?? { scope: "global" as const, max: setting("system.agent.maxProcesses") };
    leave(w, "timeout");
    w.reject(new SlotTimeout(b.scope, b.max));
}

function leave(w: Waiter, why: string): void {
    const at = waiting.indexOf(w);
    if (at < 0) return;
    waiting.splice(at, 1);
    clearTimeout(w.timer);
    if (w.announced !== null) {
        w.announced = null;
        need().announce(w.userId, w.conversationId, null);
        console.log(
            `[agent] ${w.conversationId} left the queue (${why}) after ${Date.now() - w.joinedAt} ms, ${waiting.length} waiting`,
        );
    }
    // Others move up. A drain in progress announces when it ends.
    if (!draining) announce();
}

/** Tell each waiter where it stands, once per change. */
function announce(): void {
    waiting.forEach((w, i) => {
        const position = i + 1;
        if (w.announced === position) return;
        const first = w.announced === null;
        w.announced = position;
        need().announce(w.userId, w.conversationId, position);
        if (first) {
            const scope = w.blocked?.scope === "user" ? "own limit" : "server limit";
            console.log(`[agent] ${w.conversationId} queued for ${w.userId} at ${position} (${scope})`);
        }
    });
}

/** End the wait of one conversation. False when it was not waiting. */
export function abortWait(conversationId: string, reason: AbortReason): boolean {
    const w = waiting.find((x) => x.conversationId === conversationId);
    if (!w) return false;
    leave(w, reason);
    w.reject(new SlotAbort(reason));
    return true;
}

/** End every wait of a user. */
export function abortUserWaits(userId: string, reason: AbortReason): void {
    for (const w of waiting.filter((x) => x.userId === userId)) abortWait(w.conversationId, reason);
}

/** The position (1 is next) of a conversation that waits for a slot, or undefined. */
export function queuePosition(userId: string, conversationId: string): number | undefined {
    const at = waiting.findIndex((w) => w.userId === userId && w.conversationId === conversationId);
    return at < 0 ? undefined : at + 1;
}

/** Requests waiting for a slot. */
export function waitingCount(): number {
    return waiting.length;
}

/**
 * The user's last client went away. The queued requests are dropped after a short grace period unless a client
 * returns: nobody is left to see them wait, and a request nobody wants should not take a slot later.
 */
export function userDisconnected(userId: string, connected: () => boolean): void {
    if (!waiting.some((w) => w.userId === userId)) return;
    clearTimeout(leaving.get(userId));
    const timer = setTimeout(() => {
        leaving.delete(userId);
        if (!connected()) abortUserWaits(userId, "disconnected");
    }, DISCONNECT_GRACE_MS);
    timer.unref?.();
    leaving.set(userId, timer);
}

setInterval(() => {
    if (waiting.length) changed();
}, RECHECK_MS).unref();
