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
import { parseTimeToToday, type Scheduler } from "./scheduler";

const text = (t: string) => ({ type: "text" as const, text: t });
const ok = (t: string): AgentToolResult<null> => ({ content: [text(t)], details: null });
const emptySchema = Type.Object({});

export interface ExtraDeps {
    memory: MemoryStore;
    skills: SkillStore;
    sessions: SessionStore;
    scheduler: Scheduler;
    /** Run a focused sub-agent to completion and return its final answer. */
    runSubagent: (task: string, signal?: AbortSignal) => Promise<string>;
    /** Push a notification to the user (ntfy). Returns whether it was sent. */
    notifyUser?: (message: string, opts: { title?: string; priority?: "default" | "high" | "urgent" }) => Promise<{ sent: boolean; reason?: string }>;
    /** Read the rolling local meeting transcript. */
    getTranscript?: () => string;
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
            "Delegate a focused sub-task to a fresh sub-agent that uses a STRONGER model (gpt-5.5) with deep thinking — ideal for hard reasoning, research, or self-contained side-quests. Returns its result.",
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

    const scheduleSchema = Type.Object({
        task: Type.String({ description: "The instruction for the agent to run when this fires (be specific and self-contained)." }),
        label: Type.Optional(Type.String({ description: "Short label." })),
        atTime: Type.Optional(Type.String({ description: 'One-shot time of day "HH:MM" (today, or tomorrow if already passed).' })),
        everyMinutes: Type.Optional(Type.Number({ description: "Run repeatedly every N minutes." })),
        afterTime: Type.Optional(Type.String({ description: 'Only run at/after this time of day "HH:MM" (e.g. "17:30").' })),
        beforeTime: Type.Optional(Type.String({ description: 'Only run before this time of day "HH:MM".' })),
    });
    const schedule_task: AgentTool<typeof scheduleSchema> = {
        name: "schedule_task",
        label: "Schedule task",
        description:
            "Schedule yourself to run a task later: once (atTime), or repeatedly (everyMinutes), optionally only within a time-of-day window (afterTime/beforeTime). E.g. lock the PC if idle, every 5 min after 17:30.",
        parameters: scheduleSchema,
        async execute(_id, p: Static<typeof scheduleSchema>): Promise<AgentToolResult<null>> {
            const ts = p.atTime ? parseTimeToToday(p.atTime) : undefined;
            if (!ts && !p.everyMinutes) return ok("Specify a valid atTime (one-shot, HH:MM) or everyMinutes (recurring).");
            const job = deps.scheduler.add({
                task: p.task,
                label: p.label ?? p.task.slice(0, 40),
                ...(ts ? { atTimestamp: ts } : {}),
                ...(p.everyMinutes ? { everyMinutes: p.everyMinutes } : {}),
                ...(p.afterTime ? { afterTime: p.afterTime } : {}),
                ...(p.beforeTime ? { beforeTime: p.beforeTime } : {}),
            });
            return ok(`Scheduled (${job.id}): ${job.label}.`);
        },
    };

    const list_schedules: AgentTool<typeof emptySchema> = {
        name: "list_schedules",
        label: "List schedules",
        description: "List scheduled tasks.",
        parameters: emptySchema,
        async execute(): Promise<AgentToolResult<null>> {
            const jobs = deps.scheduler.list();
            return ok(
                jobs.length
                    ? jobs
                          .map((j) => {
                              const when = j.everyMinutes ? `every ${j.everyMinutes}m` : j.atTimestamp ? new Date(j.atTimestamp).toLocaleString() : "?";
                              const win = j.afterTime || j.beforeTime ? ` [${j.afterTime ?? ""}–${j.beforeTime ?? ""}]` : "";
                              return `${j.id}: ${j.label} — ${when}${win}`;
                          })
                          .join("\n")
                    : "No scheduled tasks.",
            );
        },
    };

    const cancelSchema = Type.Object({ id: Type.String() });
    const cancel_schedule: AgentTool<typeof cancelSchema> = {
        name: "cancel_schedule",
        label: "Cancel schedule",
        description: "Cancel a scheduled task by id.",
        parameters: cancelSchema,
        async execute(_id, p: Static<typeof cancelSchema>): Promise<AgentToolResult<null>> {
            return ok(deps.scheduler.cancel(p.id) ? `Cancelled ${p.id}.` : `No schedule ${p.id}.`);
        },
    };

    const tools: AgentTool<any>[] = [
        web_search,
        fetch_url,
        remember,
        recall,
        search_conversations,
        list_skills,
        use_skill,
        schedule_task,
        list_schedules,
        cancel_schedule,
        spawn_subagent,
    ];

    if (deps.notifyUser) {
        const notifyUser = deps.notifyUser;
        const notifySchema = Type.Object({
            message: Type.String({ description: "What to tell the user. Be specific and useful." }),
            priority: Type.Optional(
                Type.Union([Type.Literal("default"), Type.Literal("high"), Type.Literal("urgent")], {
                    description: "default = FYI; high = notable; urgent = needs attention now.",
                }),
            ),
            title: Type.Optional(Type.String({ description: "Short title (default 'PiKVM Agent')." })),
        });
        const notify_user: AgentTool<typeof notifySchema> = {
            name: "notify_user",
            label: "Notify user",
            description:
                "Send a push notification to the user's phone (ntfy) when something happens they'd want to know about while away — a new email/message, a meeting starting, a long task finishing, or something needing attention. Only fires if the user is currently active. Don't spam: notify at meaningful moments.",
            parameters: notifySchema,
            async execute(_id, p: Static<typeof notifySchema>): Promise<AgentToolResult<null>> {
                const r = await notifyUser(p.message, {
                    ...(p.priority ? { priority: p.priority } : {}),
                    ...(p.title ? { title: p.title } : {}),
                });
                return ok(r.sent ? "Notification sent." : `Not sent (${r.reason ?? "unknown"}).`);
            },
        };
        tools.push(notify_user);
    }

    if (deps.getTranscript) {
        const getTranscript = deps.getTranscript;
        const read_transcript: AgentTool<typeof emptySchema> = {
            name: "read_transcript",
            label: "Read transcript",
            description:
                "Read the live transcript of the current meeting (transcribed locally from the target's audio). Use it to answer 'what did they just say', summarise, or draft a reply. Empty if no meeting/audio.",
            parameters: emptySchema,
            async execute(): Promise<AgentToolResult<null>> {
                const t = getTranscript().trim();
                return ok(t ? `Recent meeting transcript:\n\n${t}` : "No transcript yet (no meeting audio captured).");
            },
        };
        tools.push(read_transcript);
    }

    return tools;
}
