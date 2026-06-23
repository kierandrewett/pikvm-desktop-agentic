/**
 * Pure approval-gate UI logic, factored out of the React sidebar so it can be tested
 * without a browser. These two functions decide whether the agent is currently waiting
 * on the user — the exact thing that, when wrong, hangs a run with no visible prompt.
 *
 * History: the server reused authorization ids (`op_1` every session) and the sidebar
 * kept a `decided` set forever, so a fresh `op_1` looked already-approved → no buttons
 * → the agent waited at the gate indefinitely. The fix is unique ids (server) PLUS
 * `pruneDecided` (never let `decided` hold an id the server no longer lists as pending).
 * `pickPendingAuth` is the single source of truth for "is there a prompt to show".
 */

import type { AuthRequest } from "../reviewer";

export interface PendingAuthInputs {
    /** The server's live pending requests (from /api/state). Authoritative. */
    pendingAuths: AuthRequest[];
    /** The ids the server is currently blocked on (from /api/state). */
    pendingAuthIds: string[];
    /** Ids we've optimistically marked decided after clicking approve/deny. */
    decided: ReadonlySet<string>;
    /** Auth requests seen in the message stream, oldest → newest (fallback source). */
    messageAuths: AuthRequest[];
    /** Is a run ACTIVE right now? When true, a not-yet-decided auth from the live message
     *  stream is actionable even if the polled pendingAuthIds hasn't confirmed it — the
     *  /api/state poll can be frozen mid-run (occluded-renderer timer throttling), so we
     *  must NOT depend on it to show the prompt. A reloaded transcript is not "busy", so a
     *  stale auth still won't reappear. */
    busy?: boolean;
}

/**
 * The single authorization prompt to surface right now, or null. Prefers the server's
 * live pending list; falls back to the message stream only for requests the server
 * still confirms are pending (so a stale prompt from a reloaded transcript can't
 * reappear). An id we've locally decided is hidden — but see `pruneDecided`: `decided`
 * must be kept honest or this filter will wrongly hide a genuinely-pending request.
 */
export function pickPendingAuth(inp: PendingAuthInputs): AuthRequest | null {
    const live = inp.pendingAuths.filter((r) => !inp.decided.has(r.id));
    if (live.length) return live[live.length - 1]!;
    const stillPending = new Set(inp.pendingAuthIds);
    for (let i = inp.messageAuths.length - 1; i >= 0; i--) {
        const c = inp.messageAuths[i];
        // Actionable if the server still lists it pending OR a run is live (the agent is
        // blocked on exactly this prompt and the poll may be frozen). Never when idle —
        // that keeps a reloaded transcript's old auth from re-surfacing.
        if (c && !inp.decided.has(c.id) && (stillPending.has(c.id) || inp.busy)) return c;
    }
    return null;
}

/** True once the server no longer lists the request as pending (i.e. it's resolved). */
export function isAuthHandled(reqId: string, pendingAuthIds: string[], decided: ReadonlySet<string>): boolean {
    return decided.has(reqId) || !pendingAuthIds.includes(reqId);
}

/**
 * Keep `decided` to ONLY ids the server still lists as pending — ones we just approved
 * whose resolution hasn't polled back yet. Drops everything else so the set can't go
 * stale and collide with a future id. Returns the same Set instance when unchanged
 * (so a React setState bails instead of looping).
 */
export function pruneDecided(decided: ReadonlySet<string>, pendingAuthIds: string[]): ReadonlySet<string> {
    if (decided.size === 0) return decided;
    const pending = new Set(pendingAuthIds);
    let changed = false;
    const next = new Set<string>();
    for (const id of decided) {
        if (pending.has(id)) next.add(id);
        else changed = true;
    }
    return changed ? next : decided;
}
