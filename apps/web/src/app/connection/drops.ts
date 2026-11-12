/** The last outages, kept for this tab only (sessionStorage): a reload keeps them, a new tab starts empty. */

import { MAX_OUTAGES, type Outage, type OutageCause } from "./machine";

export const DROPS_KEY = "pikvm.connection.drops";

const CAUSES: ReadonlyArray<OutageCause> = ["host", "device", "pikvm", "chat", "picture", "slow"];

function parseOutage(value: unknown): Outage | null {
    if (typeof value !== "object" || value === null) return null;
    const { startedAt, endedAt, longestRoundTripMs, cause } = value as Record<string, unknown>;
    if (typeof startedAt !== "number" || typeof endedAt !== "number" || typeof longestRoundTripMs !== "number") return null;
    if (typeof cause !== "string" || !CAUSES.includes(cause as OutageCause)) return null;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
    return { startedAt, endedAt, longestRoundTripMs, cause: cause as OutageCause };
}

export function loadDrops(storage: Pick<Storage, "getItem"> | undefined): ReadonlyArray<Outage> {
    try {
        const raw = storage?.getItem(DROPS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(parseOutage).filter((outage): outage is Outage => outage !== null).slice(0, MAX_OUTAGES);
    } catch {
        return [];
    }
}

export function saveDrops(storage: Pick<Storage, "setItem"> | undefined, drops: ReadonlyArray<Outage>): void {
    try {
        storage?.setItem(DROPS_KEY, JSON.stringify(drops));
    } catch {
        // Storage full or blocked: the list stays in memory.
    }
}
