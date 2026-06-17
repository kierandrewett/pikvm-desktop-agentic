/**
 * Cognitive tools for the agent beyond computer-use: web search/fetch, long-term
 * memory, conversation search, skills, and sub-agents.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { webSearch, fetchUrl } from "./web";
import type { MemoryStore } from "./memory";
import type { SkillStore } from "./skills";
import type { SessionStore } from "./sessions";

const text = (t: string) => ({ type: "text" as const, text: t });
const ok = (t: string): AgentToolResult<null> => ({ content: [text(t)], details: null });
const emptySchema = Type.Object({});

export interface ExtraDeps {
    memory: MemoryStore;
    skills: SkillStore;
    sessions: SessionStore;
    /** Run a focused sub-agent to completion and return its final answer. */
    runSubagent: (task: string, signal?: AbortSignal) => Promise<string>;
}

export function createExtraTools(deps: ExtraDeps): AgentTool<any>[] {
    const searchSchema = Type.Object({ query: Type.String({ description: "Search query." }) });
    const web_search: AgentTool<typeof searchSchema> = {
        name: "web_search",
        label: "Web search",
        description: "Search the web (DuckDuckGo) and get titles, URLs, and snippets.",
        parameters: searchSchema,
        async execute(_id, p: Static<typeof searchSchema>) {
            try {
                const results = await webSearch(p.query);
                if (!results.length) return ok("No results.");
                return ok(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"));
            } catch (e) {
                return ok(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        },
    };

    const fetchSchema = Type.Object({ url: Type.String({ description: "URL to fetch." }) });
    const fetch_url: AgentTool<typeof fetchSchema> = {
        name: "fetch_url",
        label: "Fetch URL",
        description: "Fetch a web page and return its readable text.",
        parameters: fetchSchema,
        async execute(_id, p: Static<typeof fetchSchema>) {
            try {
                return ok(await fetchUrl(p.url));
            } catch (e) {
                return ok(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        },
    };

    const rememberSchema = Type.Object({
        text: Type.String({ description: "A durable fact worth remembering." }),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags." })),
    });
    const remember: AgentTool<typeof rememberSchema> = {
        name: "remember",
        label: "Remember",
        description: "Save a durable fact to long-term memory for future sessions.",
        parameters: rememberSchema,
        async execute(_id, p: Static<typeof rememberSchema>) {
            deps.memory.add(p.text, p.tags ?? []);
            return ok("Saved to memory.");
        },
    };

    const recallSchema = Type.Object({ query: Type.String({ description: "What to recall." }) });
    const recall: AgentTool<typeof recallSchema> = {
        name: "recall",
        label: "Recall",
        description: "Search long-term memory for relevant saved facts.",
        parameters: recallSchema,
        async execute(_id, p: Static<typeof recallSchema>) {
            const mems = deps.memory.search(p.query);
            return ok(mems.length ? mems.map((m) => `• ${m.text}`).join("\n") : "No relevant memories.");
        },
    };

    const convSchema = Type.Object({ query: Type.String({ description: "Text to find in past conversations." }) });
    const search_conversations: AgentTool<typeof convSchema> = {
        name: "search_conversations",
        label: "Search conversations",
        description: "Search your past conversations/sessions for relevant context.",
        parameters: convSchema,
        async execute(_id, p: Static<typeof convSchema>) {
            const hits = deps.sessions.search(p.query);
            return ok(hits.length ? hits.map((h) => `• ${h.title}: …${h.snippet}…`).join("\n") : "No matching conversations.");
        },
    };

    const list_skills: AgentTool<typeof emptySchema> = {
        name: "list_skills",
        label: "List skills",
        description: "List available skills (reusable playbooks).",
        parameters: emptySchema,
        async execute() {
            const skills = deps.skills.list();
            return ok(skills.length ? skills.map((s) => `• ${s.name} — ${s.description || s.title}`).join("\n") : "No skills.");
        },
    };

    const useSkillSchema = Type.Object({ name: Type.String({ description: "Skill name from list_skills." }) });
    const use_skill: AgentTool<typeof useSkillSchema> = {
        name: "use_skill",
        label: "Use skill",
        description: "Load a skill's playbook and follow its steps.",
        parameters: useSkillSchema,
        async execute(_id, p: Static<typeof useSkillSchema>) {
            const body = deps.skills.get(p.name);
            return ok(body ? `Skill "${p.name}":\n\n${body}` : `No skill named "${p.name}".`);
        },
    };

    const subSchema = Type.Object({ task: Type.String({ description: "A focused, self-contained task for the sub-agent." }) });
    const spawn_subagent: AgentTool<typeof subSchema> = {
        name: "spawn_subagent",
        label: "Sub-agent",
        description:
            "Delegate a focused sub-task to a fresh sub-agent (its own context) and get back its result. Use for research or self-contained side-quests.",
        parameters: subSchema,
        async execute(_id, p: Static<typeof subSchema>, signal) {
            try {
                const result = await deps.runSubagent(p.task, signal);
                return ok(result || "(sub-agent returned nothing)");
            } catch (e) {
                return ok(`Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        },
    };

    return [web_search, fetch_url, remember, recall, search_conversations, list_skills, use_skill, spawn_subagent];
}
