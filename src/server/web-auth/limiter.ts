/**
 * Failed sign-in attempts, counted per client address, with exponential backoff and one ceiling for everybody.
 *
 * A person mistypes: the first few failures from an address cost nothing. After that each further failure doubles the
 * wait before that address may try again (1 s, 2 s, 4 s ... up to a quarter of an hour), and until the wait is over every
 * attempt from it is refused, the right password included. A success clears the address. Apart from that, when
 * the whole host sees too many failures in a minute (an attack from many addresses), every attempt waits for the minute to
 * pass. Sessions already signed in never come here.
 */

export interface LimiterOptions {
    now: () => number;
    /** Failures an address may make before it is slowed down. */
    freeFailures?: number;
    /** The wait after the first failure past the free ones; doubles with each. */
    baseMs?: number;
    maxMs?: number;
    /** Failures, from all addresses, allowed within `windowMs`. */
    ceiling?: number;
    windowMs?: number;
    /** An address nobody has failed from for this long is forgotten. */
    forgetMs?: number;
    /** The most addresses remembered; the oldest are dropped first. */
    maxEntries?: number;
}

interface Entry {
    failures: number;
    /** Not before this time (ms since the epoch). */
    until: number;
    last: number;
}

export class AttemptLimiter {
    private readonly now: () => number;
    private readonly freeFailures: number;
    private readonly baseMs: number;
    private readonly maxMs: number;
    private readonly ceiling: number;
    private readonly windowMs: number;
    private readonly forgetMs: number;
    private readonly maxEntries: number;
    private readonly entries = new Map<string, Entry>();
    private recent: number[] = [];

    constructor(opts: LimiterOptions) {
        this.now = opts.now;
        this.freeFailures = opts.freeFailures ?? 3;
        this.baseMs = opts.baseMs ?? 1000;
        this.maxMs = opts.maxMs ?? 15 * 60_000;
        this.ceiling = opts.ceiling ?? 60;
        this.windowMs = opts.windowMs ?? 60_000;
        this.forgetMs = opts.forgetMs ?? 60 * 60_000;
        this.maxEntries = opts.maxEntries ?? 10_000;
    }

    /** Milliseconds this address must still wait; 0 = it may try now. */
    wait(address: string): number {
        const now = this.now();
        this.recent = this.recent.filter((t) => t > now - this.windowMs);
        const global = this.recent.length >= this.ceiling ? this.recent[0]! + this.windowMs - now : 0;
        const entry = this.entries.get(address);
        const own = entry ? entry.until - now : 0;
        return Math.max(0, global, own);
    }

    fail(address: string): void {
        const now = this.now();
        this.recent.push(now);
        const entry = this.entries.get(address) ?? { failures: 0, until: 0, last: now };
        entry.failures += 1;
        entry.last = now;
        if (entry.failures > this.freeFailures) {
            const doublings = Math.min(entry.failures - this.freeFailures - 1, 30);
            entry.until = now + Math.min(this.baseMs * 2 ** doublings, this.maxMs);
        }
        // Re-inserted, so Map order is least recently failed first.
        this.entries.delete(address);
        this.entries.set(address, entry);
        this.prune(now);
    }

    succeed(address: string): void {
        this.entries.delete(address);
    }

    private prune(now: number): void {
        for (const [address, entry] of this.entries) {
            if (now - entry.last <= this.forgetMs && this.entries.size <= this.maxEntries) break;
            this.entries.delete(address);
        }
    }
}
