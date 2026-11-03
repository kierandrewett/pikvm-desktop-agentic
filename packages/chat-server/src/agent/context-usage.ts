/**
 * Context-window size from one model call's usage, as the runtime reports it on an assistant message. After a call
 * the window holds everything the call read (new input, cache reads and writes) plus what it wrote, which is also the
 * start of the next call's prompt. The total the runtime reports is used when present.
 */
export interface ModelUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function contextTokens(u: ModelUsage | undefined): number {
    if (!u) return 0;
    const total = count(u.totalTokens);
    if (total > 0) return Math.round(total);
    return Math.round(count(u.input) + count(u.cacheRead) + count(u.cacheWrite) + count(u.output));
}
