/**
 * Metrics collection — structured, outcome-focused events for later analysis (and
 * for feeding to an LLM to actually improve the agent). Distinct from the raw
 * debug-log: this captures the SEMANTIC funnel and OUTCOMES — when a suggested
 * action was shown, what was on screen, whether/when the user tapped it, and how the
 * resulting run turned out — plus run/tool/auth/user-action events. Be greedy: more
 * signal now is better. One JSONL file per day under <data>/metrics/, with full-frame
 * JPEGs saved beside it (referenced by path) so "what was on screen" is reviewable.
 */

import { appendFile, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Metrics {
    private readonly dir: string;
    private readonly framesDir: string;
    private seq = 0;

    constructor(dir: string) {
        this.dir = dir;
        this.framesDir = join(dir, "frames");
        try {
            mkdirSync(this.framesDir, { recursive: true });
        } catch {
            /* best-effort */
        }
    }

    private file(): string {
        const day = new Date().toISOString().slice(0, 10);
        return join(this.dir, `metrics-${day}.jsonl`);
    }

    /** Persist a JPEG frame and return its path relative to the metrics dir (or
     *  undefined). Lets an analyst / LLM later SEE what was on screen for an event. */
    saveFrame(jpeg: Buffer | undefined, label: string): string | undefined {
        if (!jpeg || !jpeg.length) return undefined;
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const name = `${stamp}-${label}-${this.seq++}.jpg`;
            writeFileSync(join(this.framesDir, name), jpeg);
            return `frames/${name}`;
        } catch {
            return undefined;
        }
    }

    // Buffer + async flush so recording never blocks the event loop on the hot path.
    private buf = "";
    private timer: NodeJS.Timeout | null = null;

    /** Append one timestamped, structured metric record. */
    record(kind: string, data?: Record<string, unknown>): void {
        try {
            const rec = { ts: new Date().toISOString(), kind, ...(data ?? {}) };
            this.buf += JSON.stringify(rec) + "\n";
            if (this.buf.length > 64 * 1024) this.flush();
            else if (!this.timer) {
                this.timer = setTimeout(() => this.flush(), 800);
                if (this.timer.unref) this.timer.unref();
            }
        } catch {
            /* metrics must never disturb the agent */
        }
    }

    private flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const data = this.buf;
        this.buf = "";
        if (!data) return;
        appendFile(this.file(), data, () => {
            /* best-effort async write */
        });
    }
}
