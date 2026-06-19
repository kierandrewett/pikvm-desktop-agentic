/**
 * Agent long-term memory. File-backed, keyword-searchable. The agent can
 * `remember` facts and `recall` them across sessions.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

export interface Memory {
    id: string;
    text: string;
    tags: string[];
    createdAt: number;
}

function tokenize(s: string): string[] {
    return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
}

export class MemoryStore {
    private mems: Memory[] = [];

    /**
     * Write-through hook fired on every add, so a fact saved here is also
     * mirrored into the Atlas vault (set once the Atlas bridge connects).
     */
    onAdd?: (m: Memory) => void;

    constructor(private readonly path: string) {
        if (existsSync(path)) {
            try {
                this.mems = JSON.parse(readFileSync(path, "utf-8"));
            } catch {
                /* start empty */
            }
        }
    }

    private save() {
        try {
            writeFileSync(this.path, JSON.stringify(this.mems, null, 2));
        } catch {
            /* best-effort */
        }
    }

    add(text: string, tags: string[] = []): Memory {
        const m: Memory = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, tags, createdAt: Date.now() };
        this.mems.push(m);
        this.save();
        try {
            this.onAdd?.(m);
        } catch {
            /* mirroring is best-effort; never let it break a local save */
        }
        return m;
    }

    /** Keyword-overlap search, most relevant first. */
    search(query: string, limit = 6): Memory[] {
        const q = new Set(tokenize(query));
        if (q.size === 0) return this.recent(limit);
        return this.mems
            .map((m) => {
                const words = new Set(tokenize(m.text + " " + m.tags.join(" ")));
                let score = 0;
                for (const t of q) if (words.has(t)) score++;
                return { m, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
            .slice(0, limit)
            .map((x) => x.m);
    }

    recent(limit = 10): Memory[] {
        return [...this.mems].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }

    count(): number {
        return this.mems.length;
    }

    delete(id: string): void {
        this.mems = this.mems.filter((m) => m.id !== id);
        this.save();
    }
}
