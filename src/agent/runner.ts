/**
 * The embedded Pi agent runner.
 *
 * Wires the Pi `Agent` loop to the PiKVM control core, the ChatGPT-subscription
 * auth, the operation reviewer, and the presence-DND gate. Exposes a small
 * control surface the UI bridge and slash commands drive.
 */

import {
    Agent,
    estimateContextTokens,
    estimateTokens,
    shouldCompact,
    generateSummary,
    DEFAULT_COMPACTION_SETTINGS,
    type AgentEvent,
    type AgentMessage,
    type AgentTool,
    type AgentLoopTurnUpdate,
} from "@earendil-works/pi-agent-core";
import { getModel, getModels, registerBuiltInApiProviders, type Model, type ImageContent } from "@earendil-works/pi-ai";
import { resolve, dirname } from "path";
import { PiKvmControl } from "../pikvm-control";
import { OperationReviewer, type Operation } from "../reviewer";
import { PresenceMonitor } from "../presence";
import { CodexAuth } from "./auth";
import { createTools } from "./tools";
import { createExtraTools } from "./extra-tools";
import { BackgroundTasks } from "./background";
import { ScreenshotHistory } from "./screenshot-history";
import { MemoryStore } from "./memory";
import { SkillStore } from "./skills";
import type { InputTracker } from "../input-tracker";
import { SessionStore, agentMessagesToUi, type SessionMeta } from "./sessions";
import type { PiKvmUIMessage } from "./protocol";

registerBuiltInApiProviders();

const PROVIDER = "openai-codex";
/** Default model for the main chat loop — capable by default. */
const DEFAULT_MODEL = "gpt-5.5";
/** Model sub-agents use for hard thinking / deep work. */
const SUBAGENT_MODEL = "gpt-5.5";

function systemPrompt(goal?: string, memoryCount = 0): string {
    return [
        "You operate a real computer through a PiKVM, as if you were a careful human at the keyboard and mouse.",
        "",
        "Loop: call `screenshot` to see the screen, decide ONE next action, perform it, then screenshot again to verify before continuing.",
        "Coordinates are in the pixels of the most recent screenshot. Re-screenshot after anything that changes the screen (scroll, navigation, window changes).",
        "Type with `type_text` (it already feels human — do not add your own delays; set background:true for long text and use `wait_for_task`). Use `press_key`/`hotkey` for keys and shortcuts.",
        "CLICKING HAS SIDE EFFECTS — only click when you have confirmed exactly what is under the pointer (a specific button, link, menu item or field). If you merely want to hover, position, or reveal something, use `move_mouse`, not `click`. When unsure what an element is, screenshot/zoom to confirm before clicking.",
        "To focus or raise a window, click its TASKBAR/DOCK entry or its TITLEBAR — never click a random spot inside the window, which can trigger a control, move a caret, or deselect something. Only click inside a window's content when you are intentionally activating a specific element there.",
        "Never assume what an icon or button does. Reveal tooltips (hover and wait, or hold Alt), expand sidebars/menus, OCR labels, or `web_search` how the app works BEFORE interacting (see the `understand-ui` skill). Prefer reversible exploration; if you are genuinely unsure how an app works after doing your due diligence, ASK THE USER. When clicking, aim for a natural point within an element, not always its exact centre.",
        "Actively arrange the screen so you can SEE what you need: maximize/restore windows (titlebar button or double-click the titlebar), scroll within any scrollable area, resize windows/panes by dragging edges, switch tabs, and expand collapsed sections. If something is cut off or hard to read, change the view rather than guessing.",
        "For dense or small text where accuracy matters (calendars, tables, lists, code, dialog text), DO NOT guess from the full screenshot — `ocr` the relevant region and/or take a cropped `screenshot` to zoom in, and re-check before stating any facts. If unsure, zoom further rather than guessing.",
        "NEVER assume or approximate. Find absolute answers: exact dates, exact times (e.g. 13:15, not '~13:15'), exact names, numbers and statuses, read directly from the screen. If you need an exact value (e.g. when an event is), open/expand the item to read its real details rather than estimating from a calendar grid. If you genuinely cannot determine something precisely, say so explicitly — do not fabricate a plausible value.",
        "You can also `drag` (drag-and-drop, sliders, selections) and `scroll` (trackpad-like) — move the cursor over the right area before scrolling.",
        "Use `recent_activity` to see what's already been typed (including by the user) before continuing a field.",
        "Only your most recent screenshots stay visible; older ones appear as placeholders with an id (e.g. s4). If you need to recover an earlier state, call `view_screenshot` with that id to see it again.",
        "Work in small, verifiable steps. If something looks wrong, stop and re-observe rather than guessing.",
        "LEAVE NO TRACE: when you finish, tidy up after yourself — close any windows, dialogs, terminals or apps you opened (e.g. winver/About, Run, command prompts, settings panes), discard scratch text you typed, and return the screen roughly to how you found it. Do not close windows the user already had open.",
        "APPROVAL: before ANY action that other people would see or experience, call `request_approval` with a short description and WAIT for the user's decision before doing it. This includes: sending an email, message, chat or DM; joining or starting a meeting/call; posting or commenting; submitting a form; replying or forwarding; sharing; editing or saving a shared/cloud document; accepting/declining invites; making a purchase; or anything with an outward side effect. Also pause before destructive/irreversible actions (deleting data, rebooting, privileged commands). Reading, navigating, searching and drafting (without sending) do NOT need approval.",
        "",
        "You also have cognitive tools: `web_search`/`fetch_url` for the internet, `remember`/`recall` for long-term memory across sessions, `search_conversations` to look up past sessions, `list_skills`/`use_skill` for reusable playbooks, and `spawn_subagent` to delegate a focused side-task to a fresh sub-agent.",
        "For questions about internal corporate processes/policies, use Neo (neo.capgemini.com) in the target's browser — see the `neo-corporate-help` skill.",
        memoryCount > 0 ? `You have ${memoryCount} saved memories — use \`recall\` when prior context might help.` : "",
        goal ? `\nStanding goal for this session:\n${goal}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

const SUBAGENT_PROMPT =
    "You are a focused sub-agent. Complete the given task using your tools, then reply with a concise result for the parent agent. Be thorough but brief.";

export interface RunnerDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    auth: CodexAuth;
    sessionsDir: string;
    inputTracker?: InputTracker;
}

export class AgentRunner {
    readonly agent: Agent;
    private goal: string | undefined;
    private model: Model<any>;
    private modelId = DEFAULT_MODEL;
    private loopController: { stop: () => void } | undefined;
    private readonly sessions: SessionStore;
    private readonly memory: MemoryStore;
    private readonly skills: SkillStore;
    private readonly background = new BackgroundTasks();
    private readonly screenshots = new ScreenshotHistory();
    private readonly toolsForSub: AgentTool<any>[];
    private readonly subModel: Model<any>;
    private sessionId: string;

    constructor(private deps: RunnerDeps) {
        this.model = deps.auth.applyModel(getModel(PROVIDER as any, DEFAULT_MODEL as any));
        this.subModel = deps.auth.applyModel(getModel(PROVIDER as any, SUBAGENT_MODEL as any));
        const dataDir = dirname(deps.sessionsDir);
        this.sessions = new SessionStore(deps.sessionsDir);
        this.memory = new MemoryStore(resolve(dataDir, "agent-memory.json"));
        this.skills = new SkillStore(resolve(dataDir, "agent-skills"));
        // Resume the most recent session on startup so context survives restarts.
        const recent = this.sessions.list();
        this.sessionId = recent.length ? recent[0]!.id : this.sessions.create();

        const toolDeps = {
            background: this.background,
            history: this.screenshots,
            ...(deps.inputTracker ? { tracker: deps.inputTracker } : {}),
        };

        // Tools a sub-agent gets: computer-use + cognitive, minus spawn (no recursion).
        const extra = createExtraTools({
            memory: this.memory,
            skills: this.skills,
            sessions: this.sessions,
            runSubagent: (task, signal) => this.runSubagent(task, signal),
        });
        this.toolsForSub = [...createTools(deps.control, toolDeps), ...extra.filter((t) => t.name !== "spawn_subagent")];

        this.agent = new Agent({
            initialState: {
                systemPrompt: systemPrompt(undefined, this.memory.count()),
                model: this.model,
                thinkingLevel: "medium",
                tools: [...createTools(deps.control, toolDeps), ...extra],
            },
            getApiKey: async () => {
                try {
                    return await deps.auth.getToken();
                } catch {
                    return undefined;
                }
            },
            sessionId: "pikvm-agent",
            beforeToolCall: async (ctx, signal) => this.gate(ctx.toolCall.name, ctx.args, signal),
            prepareNextTurn: () => this.maybeCompact(),
            // Keep only the most recent screenshots in context — old frames are
            // stale and were the main token cost. The agent re-screenshots as needed.
            transformContext: async (messages) => this.pruneOldImages(messages),
        });

        // Restore the resumed session's transcript so the agent keeps its context.
        const restored = this.sessions.load(this.sessionId);
        if (restored.length) this.agent.state.messages = restored as any;

        // Auto-save the transcript whenever a run finishes.
        this.agent.subscribe((e) => {
            if (e.type === "agent_end") this.persist();
        });
    }

    /** The full UI transcript (with screenshots) for the current session. */
    currentUiMessages(): PiKvmUIMessage[] {
        return this.sessions.loadUi(this.sessionId);
    }

    /** Persist the sidebar's UI transcript (called by the renderer after turns). */
    saveUiMessages(messages: PiKvmUIMessage[]): void {
        this.sessions.saveUi(this.sessionId, messages);
    }

    /** Replace image data in all but the most recent few screenshots with a
     *  placeholder, so the model isn't re-sent the entire screen history. */
    private pruneOldImages(messages: AgentMessage[]): AgentMessage[] {
        try {
            const KEEP = 2;
            let kept = 0;
            const out = messages.slice();
            for (let i = out.length - 1; i >= 0; i--) {
                const m: any = out[i];
                if (!Array.isArray(m?.content) || !m.content.some((c: any) => c?.type === "image")) continue;
                if (kept < KEEP) {
                    kept++;
                    continue;
                }
                out[i] = {
                    ...m,
                    content: m.content.map((c: any) =>
                        c?.type === "image"
                            ? { type: "text", text: "[earlier screenshot omitted — call view_screenshot with the id shown to see it again]" }
                            : c,
                    ),
                };
            }
            return out;
        } catch {
            return messages;
        }
    }

    /* --------------------------- auto-compaction ------------------------- */

    /** Summarise older context when it approaches the window limit. */
    private async maybeCompact(): Promise<AgentLoopTurnUpdate | undefined> {
        try {
            const messages = this.agent.state.messages;
            const { tokens } = estimateContextTokens(messages);
            const max = (this.model as any)?.contextWindow ?? 256_000;
            if (!shouldCompact(tokens, max, DEFAULT_COMPACTION_SETTINGS)) return undefined;

            // Keep the most recent messages; summarise everything before them.
            let acc = 0;
            let cut = messages.length;
            for (let i = messages.length - 1; i >= 0; i--) {
                acc += estimateTokens(messages[i]!);
                if (acc > DEFAULT_COMPACTION_SETTINGS.keepRecentTokens) {
                    cut = i + 1;
                    break;
                }
            }
            const older = messages.slice(0, cut);
            const keep = messages.slice(cut);
            if (older.length < 3) return undefined;

            const apiKey = await this.deps.auth.getToken();
            const res: any = await generateSummary(
                older as AgentMessage[],
                this.model,
                DEFAULT_COMPACTION_SETTINGS.reserveTokens,
                apiKey,
            );
            const summary: string | null = res?.ok ? res.value : typeof res?.value === "string" ? res.value : null;
            if (!summary) return undefined;

            const summaryMsg: AgentMessage = {
                role: "user",
                content: `[Summary of earlier conversation]\n${summary}`,
                timestamp: Date.now(),
            } as AgentMessage;
            const compacted = [summaryMsg, ...keep];
            this.agent.state.messages = compacted;
            return {
                context: { systemPrompt: this.agent.state.systemPrompt, messages: compacted, tools: this.agent.state.tools },
            };
        } catch {
            return undefined;
        }
    }

    /* ------------------------------ subagents ---------------------------- */

    /** Run a focused sub-agent to completion and return its final answer. */
    private async runSubagent(task: string, signal?: AbortSignal): Promise<string> {
        const sub = new Agent({
            initialState: {
                systemPrompt: SUBAGENT_PROMPT,
                // Sub-agents use the stronger model + deeper thinking for hard work.
                model: this.subModel,
                thinkingLevel: "high",
                tools: this.toolsForSub,
            },
            getApiKey: async () => {
                try {
                    return await this.deps.auth.getToken();
                } catch {
                    return undefined;
                }
            },
            sessionId: `pikvm-subagent-${Date.now()}`,
            beforeToolCall: async (ctx, sig) => this.gate(ctx.toolCall.name, ctx.args, sig),
        });
        const onAbort = () => sub.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            await sub.prompt(task);
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
        const last: any = [...sub.state.messages].reverse().find((m: any) => m.role === "assistant");
        const content = last?.content;
        if (typeof content === "string") return content;
        return (content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n")
            .trim();
    }

    private persist(): void {
        const messages = this.agent.state.messages;
        if (messages.length) this.sessions.save(this.sessionId, messages as any);
    }

    /* ----------------------------- sessions ----------------------------- */

    listSessions(): SessionMeta[] {
        return this.sessions.list();
    }

    currentSessionId(): string {
        return this.sessionId;
    }

    newSession(): string {
        this.persist();
        this.stop();
        this.agent.state.messages = [];
        this.sessionId = this.sessions.create();
        return this.sessionId;
    }

    /** Resume a saved session; returns its UI messages for the sidebar to render. */
    resumeSession(id: string): PiKvmUIMessage[] {
        this.persist();
        this.stop();
        const messages = this.sessions.load(id);
        this.agent.state.messages = messages as any;
        this.sessionId = id;
        // Prefer the stored UI transcript (keeps screenshots); fall back to a
        // reconstruction from the agent messages.
        const ui = this.sessions.loadUi(id);
        return ui.length ? ui : agentMessagesToUi(messages);
    }

    deleteSession(id: string): void {
        this.sessions.delete(id);
        if (id === this.sessionId) this.newSession();
    }

    /* ------------------------------ models ------------------------------ */

    getModelId(): string {
        return this.modelId;
    }

    /** Approximate context-window usage for the header meter. */
    contextInfo(): { tokens: number; max: number } {
        const max = (this.model as any)?.contextWindow ?? 256_000;
        try {
            const est = estimateContextTokens(this.agent.state.messages as any);
            return { tokens: est.tokens, max };
        } catch {
            return { tokens: 0, max };
        }
    }

    availableModels(): string[] {
        try {
            return getModels(PROVIDER as any)
                .filter((m: any) => m.api === "openai-codex-responses")
                .map((m: any) => m.id);
        } catch {
            return [DEFAULT_MODEL];
        }
    }

    /** Presence + reviewer gate for every agent tool call. */
    private async gate(tool: string, args: unknown, signal?: AbortSignal) {
        // 1. Yield while the user is present (mic/audio active).
        try {
            await this.deps.presence.waitUntilAllowed(signal);
        } catch {
            return { block: true, reason: "Aborted while paused for user presence." };
        }
        // 2. Authorization.
        const op: Operation = { tool, args: (args as Record<string, unknown>) ?? {}, source: "agent" };
        const verdict = await this.deps.reviewer.review(op);
        if (verdict.decision === "allow") return undefined;
        if (verdict.decision === "redirect") {
            const note = verdict.text?.trim();
            if (note) this.agent.steer({ role: "user", content: note, timestamp: Date.now() });
            return { block: true, reason: `User redirected: ${note ?? "do something different"}` };
        }
        return { block: true, reason: verdict.reason ?? "Blocked by reviewer." };
    }

    subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
        return this.agent.subscribe(listener);
    }

    isStreaming(): boolean {
        return this.agent.state.isStreaming;
    }

    /** Start (or queue, if running) a task, optionally with attached images. */
    async run(task: string, images?: ImageContent[]): Promise<void> {
        this.pausedForUser = false;
        if (this.agent.state.isStreaming) {
            this.agent.followUp({ role: "user", content: task, timestamp: Date.now() });
            return;
        }
        await this.agent.prompt(task, images && images.length ? images : undefined);
    }

    /* --------------------------- pause / handoff ------------------------- */

    private pausedForUser = false;

    /** Temporarily hand control back to the user (stops the current run). */
    pauseForUser(): void {
        this.pausedForUser = true;
        this.agent.abort();
    }

    isPausedForUser(): boolean {
        return this.pausedForUser;
    }

    /** Resume after a user pause — re-evaluate since the screen may have changed. */
    resumeFromUser(): void {
        if (!this.pausedForUser) return;
        this.pausedForUser = false;
        if (this.agent.state.messages.length) {
            void this.agent.prompt(
                "[Control resumed] You paused and the user took manual control of the screen. The state may have changed — take a fresh screenshot and re-evaluate before continuing the task.",
            );
        }
    }

    /** Inject a non-disruptive side note mid-run (/btw). */
    note(text: string): void {
        this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
    }

    /** Steer the running agent with a new user message, or start one if idle. */
    steer(text: string): void {
        if (this.agent.state.isStreaming) {
            this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
        } else {
            void this.run(text);
        }
    }

    /** Set/replace the persistent goal (/goal); pinned into the system prompt. */
    setGoal(goal: string | undefined): void {
        this.goal = goal?.trim() || undefined;
        this.agent.state.systemPrompt = systemPrompt(this.goal, this.memory.count());
    }

    getGoal(): string | undefined {
        return this.goal;
    }

    stop(): void {
        this.loopController?.stop();
        this.loopController = undefined;
        this.agent.abort();
    }

    clear(): void {
        this.stop();
        this.agent.state.messages = [];
    }

    setModel(modelId: string): void {
        const m = getModel(PROVIDER as any, modelId as any);
        if (m) {
            this.model = this.deps.auth.applyModel(m);
            this.modelId = modelId;
            this.agent.state.model = this.model;
        }
    }

    /** Repeat a task until stopped, or for `count` iterations, optionally with a gap. */
    loop(task: string, opts: { count?: number; intervalMs?: number } = {}): void {
        this.loopController?.stop();
        let stopped = false;
        let iterations = 0;
        this.loopController = {
            stop: () => {
                stopped = true;
            },
        };
        const tick = async () => {
            while (!stopped && (opts.count === undefined || iterations < opts.count)) {
                iterations++;
                try {
                    await this.agent.prompt(task);
                } catch {
                    break;
                }
                if (stopped) break;
                if (opts.intervalMs) await new Promise((r) => setTimeout(r, opts.intervalMs));
            }
        };
        void tick();
    }
}
