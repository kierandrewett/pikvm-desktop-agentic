/**
 * Persistent log of past meetings. When a meeting ends, the server records its
 * transcript, the copilot's suggestions, and the end-of-meeting recap so the user
 * can look back later. Stored as JSON in userData; capped to the most recent N.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";

export interface MeetingRecord {
    id: string;
    startTs: number;
    endTs: number;
    title: string;
    transcript: string;
    suggestions: { ts: number; text: string }[];
}

export interface MeetingSummary {
    id: string;
    startTs: number;
    endTs: number;
    title: string;
    suggestionCount: number;
    hasTranscript: boolean;
}

const MAX = 50;
let counter = 0;

export class MeetingLog {
    private records: MeetingRecord[] = [];

    constructor(private readonly path: string) {
        if (existsSync(path)) {
            try {
                const parsed = JSON.parse(readFileSync(path, "utf-8"));
                if (Array.isArray(parsed)) this.records = parsed;
            } catch {
                /* start empty */
            }
        }
    }

    private save() {
        try {
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.records.slice(0, MAX), null, 2));
            renameSync(tmp, this.path);
        } catch {
            /* best-effort */
        }
    }

    /** Derive a readable title from the first suggestion, falling back to the time. */
    private static titleFor(rec: Omit<MeetingRecord, "id" | "title">): string {
        const first = rec.suggestions[0]?.text?.replace(/\s+/g, " ").trim();
        const when = new Date(rec.startTs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        if (first && first.length > 8) return `${first.slice(0, 60)}${first.length > 60 ? "…" : ""}`;
        return `Meeting · ${when}`;
    }

    add(rec: Omit<MeetingRecord, "id" | "title">): MeetingRecord {
        const full: MeetingRecord = { id: `mtg${Date.now().toString(36)}${(counter++).toString(36)}`, title: MeetingLog.titleFor(rec), ...rec };
        this.records.unshift(full);
        if (this.records.length > MAX) this.records.length = MAX;
        this.save();
        return full;
    }

    list(): MeetingSummary[] {
        return this.records.map((r) => ({
            id: r.id,
            startTs: r.startTs,
            endTs: r.endTs,
            title: r.title,
            suggestionCount: r.suggestions.length,
            hasTranscript: !!r.transcript.trim(),
        }));
    }

    get(id: string): MeetingRecord | undefined {
        return this.records.find((r) => r.id === id);
    }

    /** Most recent full records (for the agent's recall_meetings tool). */
    recent(n: number): MeetingRecord[] {
        return this.records.slice(0, Math.max(0, n));
    }
}
