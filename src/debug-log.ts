/**
 * Append-only debug/conversation log.
 *
 * Every agent turn, tool call, authorization decision, context assessment, model
 * route, error and internal step is written as a timestamped JSON line so a whole
 * session can be replayed and studied after the fact (to debug and improve the
 * agent). One file per day under <data>/logs/. Best-effort: logging never throws
 * into the agent path, and image/blob payloads are stripped so lines stay small.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Recursively trim a value for logging: drop base64/data-URLs and cap long strings
 *  and large arrays so a screenshot or transcript can't bloat the log. */
function sanitize(v: unknown, depth = 0): unknown {
    if (v == null) return v;
    if (typeof v === "string") {
        if (v.length > 600 || /^data:|^[A-Za-z0-9+/]{200,}={0,2}$/.test(v)) return `«${v.length} chars elided»`;
        return v;
    }
    if (typeof v !== "object") return v;
    if (depth > 6) return "«deep»";
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => sanitize(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "data" || k === "base64" || k === "src" || k === "image" || k === "thumb") {
            out[k] = typeof val === "string" ? `«${val.length} chars elided»` : "«blob»";
        } else {
            out[k] = sanitize(val, depth + 1);
        }
    }
    return out;
}

export class DebugLog {
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            /* best-effort */
        }
    }

    private file(): string {
        const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        return join(this.dir, `agent-${day}.jsonl`);
    }

    /** Append one timestamped record. `kind` groups records (user, tool, auth, …). */
    log(kind: string, data?: Record<string, unknown>): void {
        try {
            const rec = { ts: new Date().toISOString(), kind, ...(data ? (sanitize(data) as Record<string, unknown>) : {}) };
            appendFileSync(this.file(), JSON.stringify(rec) + "\n");
        } catch {
            /* logging must never disturb the agent */
        }
    }
}
