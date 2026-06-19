/**
 * Session persistence.
 *
 * Each session stores the agent's transcript (Pi `AgentMessage[]`) to disk so it
 * can be listed, resumed, and continued. Screenshot image data is stripped on
 * save to keep files small — the model re-screenshots on resume anyway.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiKvmUIMessage } from "./protocol";

export interface SessionMeta {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
}

interface SessionFile {
    meta: SessionMeta;
    messages: AgentMessage[];
}

function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Replace image content with a small placeholder so saved sessions stay tiny. */
function stripImages(messages: AgentMessage[]): AgentMessage[] {
    return messages.map((m: any) => {
        if (!Array.isArray(m.content)) return m;
        return {
            ...m,
            content: m.content.map((c: any) =>
                c?.type === "image" ? { type: "text", text: "[screenshot]" } : c,
            ),
        };
    });
}

function titleFrom(messages: AgentMessage[]): string {
    const firstUser: any = messages.find((m: any) => m.role === "user");
    const text =
        typeof firstUser?.content === "string"
            ? firstUser.content
            : (firstUser?.content ?? []).map((c: any) => c?.text ?? "").join(" ");
    return (text || "New session").trim().slice(0, 60) || "New session";
}

export class SessionStore {
    constructor(private readonly dir: string) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    private path(id: string) {
        return resolve(this.dir, `${id}.json`);
    }

    create(): string {
        return newId();
    }

    save(id: string, messages: AgentMessage[]): SessionMeta {
        const existing = existsSync(this.path(id)) ? this.read(id) : null;
        const now = Date.now();
        const meta: SessionMeta = {
            id,
            // Keep a generated/once-set title; only derive the first-message
            // heuristic for a brand-new session (the runner refreshes it via
            // setTitle as the conversation shifts).
            title: existing?.meta.title || titleFrom(messages),
            createdAt: existing?.meta.createdAt ?? now,
            updatedAt: now,
            messageCount: messages.length,
        };
        const file: SessionFile = { meta, messages: stripImages(messages) };
        writeFileSync(this.path(id), JSON.stringify(file));
        return meta;
    }

    /** Update just the title (e.g. an auto-generated summary). Does not reorder
     *  the session list - updatedAt is left untouched. */
    setTitle(id: string, title: string): void {
        if (!existsSync(this.path(id))) return;
        const clean = title.trim().slice(0, 80);
        if (!clean) return;
        try {
            const file = this.read(id);
            file.meta.title = clean;
            writeFileSync(this.path(id), JSON.stringify(file));
        } catch {
            /* best-effort */
        }
    }

    private read(id: string): SessionFile {
        return JSON.parse(readFileSync(this.path(id), "utf-8"));
    }

    load(id: string): AgentMessage[] {
        return existsSync(this.path(id)) ? this.read(id).messages : [];
    }

    /* ---- UI transcript (full, with screenshots) — for re-rendering on resume ---- */

    private uiPath(id: string) {
        return resolve(this.dir, `${id}.ui.json`);
    }

    saveUi(id: string, messages: PiKvmUIMessage[]): void {
        try {
            writeFileSync(this.uiPath(id), JSON.stringify(messages));
        } catch {
            /* best-effort */
        }
    }

    loadUi(id: string): PiKvmUIMessage[] {
        try {
            return existsSync(this.uiPath(id)) ? JSON.parse(readFileSync(this.uiPath(id), "utf-8")) : [];
        } catch {
            return [];
        }
    }

    list(): SessionMeta[] {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    return (JSON.parse(readFileSync(resolve(this.dir, f), "utf-8")) as SessionFile).meta;
                } catch {
                    return null;
                }
            })
            .filter((m): m is SessionMeta => !!m && m.messageCount > 0)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    delete(id: string): void {
        if (existsSync(this.path(id))) unlinkSync(this.path(id));
        if (existsSync(this.uiPath(id))) unlinkSync(this.uiPath(id));
    }

    /** Full-text search across saved conversations; returns matching snippets. */
    search(query: string, limit = 8): { id: string; title: string; snippet: string }[] {
        const q = query.toLowerCase().trim();
        if (!q) return [];
        const out: { id: string; title: string; snippet: string }[] = [];
        for (const meta of this.list()) {
            const messages = this.load(meta.id);
            for (const m of messages as any[]) {
                const text =
                    typeof m.content === "string"
                        ? m.content
                        : (m.content ?? []).map((c: any) => c?.text ?? "").join(" ");
                const idx = text.toLowerCase().indexOf(q);
                if (idx >= 0) {
                    out.push({ id: meta.id, title: meta.title, snippet: text.slice(Math.max(0, idx - 40), idx + 80).trim() });
                    break;
                }
            }
            if (out.length >= limit) break;
        }
        return out;
    }
}

/** Convert a persisted Pi transcript into UI messages for re-rendering on resume. */
export function agentMessagesToUi(messages: AgentMessage[]): PiKvmUIMessage[] {
    const out: PiKvmUIMessage[] = [];
    let counter = 0;
    for (const m of messages as any[]) {
        if (m.role === "user") {
            const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join("");
            out.push({ id: `u${counter++}`, role: "user", parts: [{ type: "text", text }] } as any);
        } else if (m.role === "assistant") {
            const parts: any[] = [];
            for (const c of m.content ?? []) {
                if (c?.type === "text" && c.text) parts.push({ type: "text", text: c.text });
                else if (c?.type === "toolCall")
                    parts.push({ type: `tool-${c.name}`, toolCallId: c.id, state: "output-available", input: c.arguments });
            }
            if (parts.length) out.push({ id: `a${counter++}`, role: "assistant", parts } as any);
        }
        // toolResult messages are folded into the preceding assistant tool parts
        // implicitly; their text summaries aren't re-rendered on resume.
    }
    return out;
}
