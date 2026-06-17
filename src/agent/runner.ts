/**
 * The embedded Pi agent runner.
 *
 * Wires the Pi `Agent` loop to the PiKVM control core, the ChatGPT-subscription
 * auth, the operation reviewer, and the presence-DND gate. Exposes a small
 * control surface the UI bridge and slash commands drive.
 */

import { Agent, estimateContextTokens, type AgentEvent } from "@earendil-works/pi-agent-core";
import { getModel, getModels, registerBuiltInApiProviders, type Model } from "@earendil-works/pi-ai";
import { PiKvmControl } from "../pikvm-control";
import { OperationReviewer, type Operation } from "../reviewer";
import { PresenceMonitor } from "../presence";
import { CodexAuth } from "./auth";
import { createTools } from "./tools";
import { SessionStore, agentMessagesToUi, type SessionMeta } from "./sessions";
import type { PiKvmUIMessage } from "./protocol";

registerBuiltInApiProviders();

const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";

function systemPrompt(goal?: string): string {
    return [
        "You operate a real computer through a PiKVM, as if you were a careful human at the keyboard and mouse.",
        "",
        "Loop: call `screenshot` to see the screen, decide ONE next action, perform it, then screenshot again to verify before continuing.",
        "Coordinates are in the pixels of the most recent screenshot. Re-screenshot after anything that changes the screen (scroll, navigation, window changes).",
        "Type with `type_text` (it already feels human — do not add your own delays). Use `press_key`/`hotkey` for keys and shortcuts.",
        "Work in small, verifiable steps. If something looks wrong, stop and re-observe rather than guessing.",
        "Before any irreversible or destructive action (deleting data, rebooting, submitting a form with side effects, running privileged commands), pause and explain what you are about to do — the human may need to authorize it.",
        goal ? `\nStanding goal for this session:\n${goal}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

export interface RunnerDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    auth: CodexAuth;
    sessionsDir: string;
}

export class AgentRunner {
    readonly agent: Agent;
    private goal: string | undefined;
    private model: Model<any>;
    private modelId = DEFAULT_MODEL;
    private loopController: { stop: () => void } | undefined;
    private readonly sessions: SessionStore;
    private sessionId: string;

    constructor(private deps: RunnerDeps) {
        this.model = deps.auth.applyModel(getModel(PROVIDER as any, DEFAULT_MODEL as any));
        this.sessions = new SessionStore(deps.sessionsDir);
        this.sessionId = this.sessions.create();

        this.agent = new Agent({
            initialState: {
                systemPrompt: systemPrompt(),
                model: this.model,
                thinkingLevel: "medium",
                tools: createTools(deps.control),
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
        });

        // Auto-save the transcript whenever a run finishes.
        this.agent.subscribe((e) => {
            if (e.type === "agent_end") this.persist();
        });
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
        return agentMessagesToUi(messages);
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

    /** Start (or queue, if running) a task. */
    async run(task: string): Promise<void> {
        if (this.agent.state.isStreaming) {
            this.agent.followUp({ role: "user", content: task, timestamp: Date.now() });
            return;
        }
        await this.agent.prompt(task);
    }

    /** Inject a non-disruptive side note mid-run (/btw). */
    note(text: string): void {
        this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
    }

    /** Set/replace the persistent goal (/goal); pinned into the system prompt. */
    setGoal(goal: string | undefined): void {
        this.goal = goal?.trim() || undefined;
        this.agent.state.systemPrompt = systemPrompt(this.goal);
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
