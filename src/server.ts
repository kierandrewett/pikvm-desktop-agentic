/**
 * Control server + PiKVM reverse proxy.
 *
 * One port hosts our own surface under `/_agent` and proxies everything else to
 * the PiKVM target (so web and desktop clients use the Pi's own UI):
 *  - /_agent/mcp       : the integrated MCP server (external clients drive the KVM)
 *  - /_agent/api/*     : the sidebar bridge (chat stream, approvals, state, login)
 *  - /_agent/<asset>   : the agent UI bundle injected into proxied pages
 *  - everything else   : proxied to PiKVM (UI, MJPEG stream, HID WebSocket, login)
 *
 * The chat stream speaks the Vercel AI SDK UI message protocol so the React
 * sidebar's `useChat` can consume it directly. The agent API moved from `/api/*`
 * to `/_agent/api/*` because PiKVM owns `/api/*` and we now proxy it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import { AgentRunner } from "./agent/runner";
import { OperationReviewer, AUTONOMY_LABELS, type Verdict, type AuthRequest } from "./reviewer";
import { PresenceMonitor } from "./presence";
import { CodexAuth } from "./agent/auth";
import { createMcpHttpHandler, type McpDeps } from "./mcp-server";
import { bridgeAgentEvents } from "./agent/ui-stream";
import { ChatBroadcast } from "./agent/broadcast";
import { isStaleUiSave } from "./agent/session-sync";
import type { PiKvmUIMessage, ServerState } from "./agent/protocol";
import { parseCommand, parseLoopArg, parsePursueArg, COMMANDS } from "./commands";
import { createPiKvmProxy } from "./proxy";
import { WebSocketServer } from "ws";
import type { TerminalSessions, ClientMsg } from "./terminal-server";
import { MouseJiggler } from "./mouse-jiggler";
import { DebugLog } from "./debug-log";
import { Metrics } from "./metrics";
import { join } from "node:path";
import { webAssets, DESKTOP_SHELL_COOKIE } from "./web-assets";
import { isAuthed, isLoopback, sessionValue, loginPage, SESSION_COOKIE } from "./web-auth";
import type { SettingsStore } from "./settings";
import type { SecretsStore } from "./secrets";
import type { AmbientMonitor } from "./ambient/monitor";
import type { SuggestionWatcher } from "./ambient/suggestions";
import type { NtfyClient } from "./ambient/ntfy";
import type { Transcriber } from "./ambient/transcriber";
import type { MeetingLog } from "./ambient/meeting-log";
import type { AmbientEvent } from "./agent/protocol";
import type { OverlayBus } from "./overlay-bus";

export interface ServerDeps extends McpDeps {
    runner: AgentRunner;
    auth: CodexAuth;
    settings: SettingsStore;
    secrets: SecretsStore;
    ambient: AmbientMonitor;
    suggestions: SuggestionWatcher;
    ntfy: NtfyClient;
    transcriber: Transcriber;
    meetingLog: MeetingLog;
    overlay: OverlayBus;
    openExternal: (url: string) => void;
    /** If set, every MCP request must present this token in the URL or x-pikvm-mcp-token. */
    mcpToken?: string;
    /** Server-hosted terminal sessions, streamed to all devices over /_agent/terminal. */
    terminalSessions?: TerminalSessions;
}

type Writer = Parameters<NonNullable<Parameters<typeof createUIMessageStream<PiKvmUIMessage>>[0]["execute"]>>[0]["writer"];

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

function json(res: ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(data);
}

function mcpTokenOk(req: IncomingMessage, url: URL, expected?: string): boolean {
    if (!expected) return true;
    const queryToken = url.searchParams.get("pikvm_mcp_token") ?? url.searchParams.get("token") ?? "";
    const headerToken = typeof req.headers["x-pikvm-mcp-token"] === "string" ? req.headers["x-pikvm-mcp-token"] : "";
    return queryToken === expected || headerToken === expected;
}

export interface ImagePart {
    type: "image";
    data: string;
    mimeType: string;
}

/** Extract the latest user text + attached images from a useChat payload. */
function lastUserMessage(messages: PiKvmUIMessage[] | undefined): { text: string; images: ImagePart[] } {
    if (!Array.isArray(messages)) return { text: "", images: [] };
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== "user") continue;
        const parts = (m.parts ?? []) as any[];
        const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
            .trim();
        const images: ImagePart[] = [];
        for (const p of parts) {
            if (p.type === "file" && typeof p.url === "string" && String(p.mediaType).startsWith("image/")) {
                const mm = p.url.match(/^data:([^;]+);base64,(.+)$/);
                if (mm) images.push({ type: "image", data: mm[2], mimeType: mm[1] });
            }
        }
        return { text, images };
    }
    return { text: "", images: [] };
}

export function startControlServer(deps: ServerDeps, port: number, host = "127.0.0.1"): ReturnType<typeof createServer> {
    const { runner, reviewer, presence, auth, settings, secrets, ambient, suggestions, ntfy, transcriber, meetingLog, control, overlay, openExternal } = deps;
    // Idle mouse-jiggler: keeps the target awake when nobody's driving. It tracks the
    // user's cursor off the proxied HID socket (onHidActivity) and the agent's via the
    // control core, restores the exact position, and holds agent ops while it nudges.
    const jiggler = new MouseJiggler({
        control,
        enabled: () => settings.get().jiggler,
        isAgentBusy: () => runner.isStreaming(),
    });
    jiggler.start();
    runner.gateBarrier = () => jiggler.waitIfJiggling();
    // Pause the idle jiggler while a document capture drives the scroll itself, so its
    // nudges can't corrupt the scroll registration.
    const mcpHandler = createMcpHttpHandler(
        deps.captureDocument
            ? {
                  ...deps,
                  captureDocument: async (o) => {
                      jiggler.stop();
                      try {
                          return await deps.captureDocument!(o);
                      } finally {
                          jiggler.start();
                      }
                  },
              }
            : deps,
    );

    const proxy = createPiKvmProxy({
        control,
        htmlInjection: (req) => webAssets.htmlInjection(req),
        onHidActivity: () => jiggler.noteUserActivity(),
    });

    // Live chat broadcast: every agent run is fanned out to ALL connected clients
    // (web + desktop) via /_agent/api/events, so they all see the conversation in
    // real time. Additive — the actor's own useChat POST stream is untouched. Each
    // run is tagged with the initiating client's id so that client ignores its echo.
    const broadcast = new ChatBroadcast();
    let runClientId: string | undefined;
    const hubBridge = bridgeAgentEvents(broadcast.writer() as unknown as Writer);
    let runSeq = 0;
    runner.subscribe((event) => {
        if (event.type === "agent_start") {
            // Stable id for the assistant message this run produces. Carried in `begin`
            // (and the replay) so every client — first-join, mid-run, or reconnect —
            // reconciles to ONE message instead of duplicating it.
            const messageId = `live-${++runSeq}-${Date.now()}`;
            broadcast.send({ type: "begin", messageId, ...(runClientId ? { clientId: runClientId } : {}) });
        }
        hubBridge(event);
        if (event.type === "agent_end") {
            broadcast.send({ type: "end" });
            runClientId = undefined;
        }
    });

    // Persistent, timestamped conversation + debug log — one JSONL file per day under
    // <data>/logs/. Captures every agent event (turns, tool calls + I/O, thinking,
    // errors), plus user prompts, authorization decisions and suggestions below, so a
    // whole session can be replayed and studied to debug + improve the agent.
    const debugLog = new DebugLog(join(settings.dir(), "logs"));
    runner.subscribe((event) => {
        const ev = event as { type?: string; assistantMessageEvent?: { type?: string } };
        const t = ev.type;
        if (typeof t !== "string") return;
        // Skip per-token streaming deltas (message_start/_end keep the full text).
        if (t.includes("delta") || t.includes("chunk")) return;
        if (t === "message_update" && ev.assistantMessageEvent?.type === "text_delta") return;
        debugLog.log(t, event as Record<string, unknown>);
    });

    // Structured, outcome-focused metrics (see src/metrics.ts) — the suggestion funnel,
    // run lifecycle + outcomes, per-tool latency, auth decisions and user actions, all
    // greedily, with on-disk frames, so a future LLM can reason over real usage.
    const metrics = new Metrics(join(settings.dir(), "metrics"));
    const suggestionShownAt = new Map<string, number>();
    const authShownAt = new Map<string, number>();
    const toolStart = new Map<string, number>();
    // Context for the run that is about to start (set by /api/chat; autonomous runs leave it null).
    let nextRunMeta: { trigger: string; task: string; suggestion?: { id: string; title: string } } | null = null;
    let run: { startedAt: number; trigger: string; task: string; tools: string[]; errors: number; suggestion?: { id: string; title: string } } | null = null;
    runner.subscribe((event) => {
        const e = event as { type?: string; toolName?: string; toolCallId?: string; id?: string; result?: { isError?: boolean; summary?: string }; output?: { isError?: boolean; summary?: string } };
        switch (e.type) {
            case "agent_start": {
                run = { startedAt: Date.now(), trigger: nextRunMeta?.trigger ?? "autonomous", task: nextRunMeta?.task ?? "", tools: [], errors: 0, ...(nextRunMeta?.suggestion ? { suggestion: nextRunMeta.suggestion } : {}) };
                nextRunMeta = null;
                metrics.record("run_started", { trigger: run.trigger, task: run.task, ...(run.suggestion ? { suggestionId: run.suggestion.id, suggestionTitle: run.suggestion.title } : {}) });
                break;
            }
            case "tool_execution_start": {
                const id = e.toolCallId ?? e.id ?? String(e.toolName);
                toolStart.set(id, Date.now());
                if (run && e.toolName) run.tools.push(e.toolName);
                break;
            }
            case "tool_execution_end": {
                const id = e.toolCallId ?? e.id ?? String(e.toolName);
                const t0 = toolStart.get(id);
                toolStart.delete(id);
                const out = e.result ?? e.output ?? {};
                const isError = !!out.isError;
                if (isError && run) run.errors++;
                metrics.record("tool", { tool: e.toolName, latencyMs: t0 ? Date.now() - t0 : null, isError, ...(out.summary ? { summary: String(out.summary).slice(0, 200) } : {}) });
                break;
            }
            case "agent_end": {
                if (!run) break;
                const r = run;
                run = null;
                const durationMs = Date.now() - r.startedAt;
                const success = r.errors === 0;
                const toolCounts = r.tools.reduce<Record<string, number>>((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
                metrics.record("run_ended", { trigger: r.trigger, task: r.task, durationMs, toolCount: r.tools.length, toolCounts, success, errors: r.errors });
                if (r.suggestion) {
                    const sug = r.suggestion;
                    // Capture the END-STATE frame so the suggestion's OUTCOME is reviewable.
                    void control
                        .screenshot()
                        .then((s) => {
                            const frame = metrics.saveFrame(s.data, "outcome");
                            metrics.record("suggestion_outcome", { suggestionId: sug.id, suggestionTitle: sug.title, success, durationMs, toolCount: r.tools.length, ...(frame ? { frame } : {}) });
                        })
                        .catch(() => metrics.record("suggestion_outcome", { suggestionId: sug.id, suggestionTitle: sug.title, success, durationMs, toolCount: r.tools.length }));
                }
                break;
            }
        }
    });

    // Ring buffer of ambient events surfaced to the sidebar feed.
    const ambientEvents: AmbientEvent[] = [];
    ambient.on("event", (e: AmbientEvent) => {
        ambientEvents.push(e);
        if (ambientEvents.length > 50) ambientEvents.splice(0, ambientEvents.length - 50);
    });
    // Live meeting-copilot suggestions.
    let ambientSuggestions: { ts: number; text: string }[] = [];
    ambient.on("suggestion", (sug: { ts: number; text: string }) => {
        ambientSuggestions.push(sug);
        if (ambientSuggestions.length > 12) ambientSuggestions = ambientSuggestions.slice(-12);
    });

    // Proactive "suggested actions" → the overlay bus, which floats a tappable card
    // over the live screen (web + desktop). An empty list clears it.
    suggestions.on("suggestions", (items: import("./overlay-bus").OverlaySuggestion[]) => {
        if (items.length) {
            const it = items[0]!;
            suggestionShownAt.set(it.id, Date.now());
            const frame = metrics.saveFrame(suggestions.lastFrame(), "suggestion");
            metrics.record("suggestion_shown", { suggestionId: it.id, title: it.title, ...(it.detail ? { detail: it.detail } : {}), task: it.task, ...(frame ? { frame } : {}) });
            debugLog.log("suggestion", { items });
        }
        overlay.emitOverlay({ type: "suggestions", items });
    });

    // Record meetings to the log (transcript + suggestions + recap) for later review.
    let currentMeeting: { startTs: number; suggestions: { ts: number; text: string }[] } | null = null;
    let meetingFinalize: NodeJS.Timeout | null = null;
    const finalizeMeeting = (endTs: number, transcript: string) => {
        if (!currentMeeting) return;
        const cm = currentMeeting;
        currentMeeting = null;
        meetingLog.add({ startTs: cm.startTs, endTs, transcript, suggestions: cm.suggestions.slice(-40) });
    };
    ambient.on("suggestion", (sug: { ts: number; text: string }) => {
        if (currentMeeting) currentMeeting.suggestions.push(sug);
    });
    ambient.on("event", (e: AmbientEvent) => {
        if (e.kind === "meeting-start") {
            // Flush any not-yet-finalized prior meeting before starting a new one.
            if (meetingFinalize) {
                clearTimeout(meetingFinalize);
                meetingFinalize = null;
                finalizeMeeting(e.ts, transcriber.getTranscript());
            }
            currentMeeting = { startTs: e.ts, suggestions: [] };
        } else if (e.kind === "meeting-end") {
            ambientSuggestions = []; // clear the live display
            if (currentMeeting) {
                // Wait for the async end-of-meeting recap suggestion to land, then save.
                const transcript = transcriber.getTranscript();
                if (meetingFinalize) clearTimeout(meetingFinalize);
                meetingFinalize = setTimeout(() => {
                    meetingFinalize = null;
                    finalizeMeeting(e.ts, transcript);
                }, 35000);
            }
        }
    });

    // Active chat stream writer (present while a run streams) so reviewer prompts
    // and presence changes can surface as data parts in real time.
    let activeWriter: Writer | undefined;

    // Bumped whenever an autonomous (scheduled) run updates the saved transcript,
    // so an idle sidebar knows to reload and show the flow.
    let uiVersion = 0;
    const bumpUi = () => {
        uiVersion++;
    };
    runner.onUiChanged = bumpUi;

    // Apply the persisted per-turn model-routing config on startup. main.ts already
    // calls runner.setModel(settings.model) (the reasoning tier); this layers the
    // fast tier + on/off switch on top so routing is live from the first run.
    {
        const mr = settings.get().modelRouting;
        runner.setRouterModels({ enabled: mr.enabled, reasoningModel: mr.reasoningModel, fastModel: mr.fastModel, subagentModel: mr.subagentModel });
    }

    // Pending authorization prompts awaiting an /api/approve response.
    const pendingAuth = new Map<string, (v: Verdict) => void>();
    // The FULL request objects, exposed in /api/state so the UI can render the auth
    // dialog from the polled state — NOT from the message stream, which is paused while
    // the agent blocks on the gate (that deadlock is why the prompt only appeared after
    // Stop: the agent waits for approval ⇄ the stream that carries the prompt is stalled).
    const pendingAuthReqs = new Map<string, AuthRequest>();
    const clearPendingAuths = () => {
        for (const resolve of pendingAuth.values()) {
            try {
                resolve({ decision: "deny" });
            } catch {
                /* ignore */
            }
        }
        pendingAuth.clear();
        pendingAuthReqs.clear();
    };
    reviewer.setPrompter((req) => {
        return new Promise<Verdict>((resolve) => {
            pendingAuth.set(req.id, resolve);
            pendingAuthReqs.set(req.id, req as AuthRequest);
            authShownAt.set(req.id, Date.now());
            metrics.record("auth_shown", { id: req.id, op: (req as { op?: unknown }).op, reason: (req as { reason?: string }).reason });
            debugLog.log("auth-request", { id: req.id, op: (req as { op?: unknown }).op, reason: (req as { reason?: string }).reason });
            activeWriter?.write({ type: "data-auth", id: req.id, data: { request: req } });
            broadcast.send({ type: "data-auth", id: req.id, data: { request: req } });
        });
    });

    presence.on("change", (s) => {
        const chunk = { type: "data-status" as const, data: { kind: "presence" as const, paused: s.paused, text: s.reason ?? "Resumed." } };
        activeWriter?.write(chunk);
        broadcast.send(chunk);
    });

    // Internal-step indicator (e.g. a blocking screen assessment before an action).
    // Broadcast-ONLY and not written to the active /api/chat stream — the sidebar
    // shows it as an ephemeral chip rather than appending it to the transcript.
    runner.onActivity = (a) => {
        broadcast.send({ type: "data-activity", data: a });
    };

    const state = (): ServerState => ({
        policy: reviewer.getPolicy(),
        autonomy: reviewer.getAutonomy(),
        presence: (() => {
            const p = presence.getState();
            return p.reason ? { paused: p.paused, reason: p.reason } : { paused: p.paused };
        })(),
        ...(runner.getGoal() ? { goal: runner.getGoal()! } : {}),
        ...(runner.getGoalLoop() ? { goalLoop: runner.getGoalLoop()! } : {}),
        loggedIn: auth.isLoggedIn(),
        streaming: runner.isStreaming(),
        acting: runner.isStreaming(),
        pausedForUser: runner.isPausedForUser(),
        model: runner.getModelId(),
        models: runner.availableModels(),
        context: runner.contextInfo(),
        uiVersion,
        pendingAuthIds: Array.from(pendingAuth.keys()),
        pendingAuths: Array.from(pendingAuthReqs.values()),
        ambient: (() => {
            const a = settings.get().ambient;
            return {
                enabled: a.enabled,
                suggest: a.suggest,
                inMeeting: ambient.isInMeeting(),
                notify: a.notify,
                meetingAssist: a.meetingAssist,
                transcribe: a.transcribe,
                ntfyTopic: a.ntfy.topic,
                ntfyBaseUrl: a.ntfy.baseUrl,
                hasToken: !!secrets.get("ntfy_token"),
                activeHours: a.activeHours,
                debug: ambient.getDebug(),
                transcript: transcriber.getTranscript(),
                transcriptActive: transcriber.isActive(),
                transcriptStatus: transcriber.getStatus(),
                transcriptSegments: transcriber.getSegments(80),
                suggestions: ambientSuggestions.slice(-6).reverse(),
                events: ambientEvents.slice(-30).reverse(),
            };
        })(),
        secrets: { items: secrets.list(), encrypted: secrets.encryptionAvailable() },
        sessionId: runner.currentSessionId(),
        sessions: runner.listSessions().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: s.messageCount,
        })),
        settings: (() => {
            const s = settings.get();
            const rc = runner.getRouterConfig();
            return {
                humanize: s.humanize,
                pauseOnPresence: s.pauseOnPresence,
                jiggler: s.jiggler,
                wpm: s.wpm,
                keyboardLayout: s.keyboardLayout,
                bindHost: s.bindHost,
                hasToken: !!s.accessToken,
                desktopUseProxy: s.desktopUseProxy,
                atlas: s.atlas,
                // Surface the runner's live router config (migrated provider/model
                // specs + the per-turn tier + any vision-guard warning).
                modelRouting: { ...s.modelRouting, lastTier: rc.lastTier, fastTierWarning: rc.fastTierWarning },
                mcpServers: s.mcpServers,
            };
        })(),
        // Providers & Models: each provider's auth state + reachable model specs.
        providers: runner.availableProviderModels(),
        schedules: runner.listSchedules().map((j) => ({
            id: j.id,
            label: j.label,
            when: j.everyMinutes
                ? `every ${j.everyMinutes}m${j.afterTime || j.beforeTime ? ` (${j.afterTime ?? ""}–${j.beforeTime ?? ""})` : ""}`
                : j.atTimestamp
                  ? new Date(j.atTimestamp).toLocaleString()
                  : "?",
        })),
        log: reviewer.getLog().slice(-100),
    });

    /** Run the agent (or a command) and stream UI messages back. */
    function streamChat(res: ServerResponse, input: string, images: ImagePart[] = []): void {
        const stream = createUIMessageStream<PiKvmUIMessage>({
            execute: async ({ writer }) => {
                activeWriter = writer;
                const unsub = runner.subscribe(bridgeAgentEvents(writer));
                const status = (text: string, kind: "info" | "loop" = "info") =>
                    writer.write({ type: "data-status", data: { kind, text } });
                try {
                    const cmd = parseCommand(input);
                    if (cmd?.known) {
                        await handleCommand(cmd.name, cmd.arg, status);
                    } else {
                        await runner.run(input, images);
                    }
                } catch (err) {
                    status(`Error: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    unsub();
                    activeWriter = undefined;
                }
            },
            onError: (e) => (e instanceof Error ? e.message : String(e)),
        });
        pipeUIMessageStreamToResponse({ response: res, stream });
    }

    async function handleCommand(name: string, arg: string, status: (t: string, k?: "info" | "loop") => void) {
        switch (name) {
            case "goal":
                if (arg) {
                    runner.setGoal(arg);
                    settings.patch({ goal: arg });
                    status(`Goal set: ${arg}`);
                } else {
                    status(runner.getGoal() ? `Current goal: ${runner.getGoal()}` : "No goal set.");
                }
                return;
            case "btw":
                runner.note(arg);
                status(`Noted: ${arg}`);
                return;
            case "loop": {
                const { count, task } = parseLoopArg(arg);
                if (!task) return status("Usage: /loop [count] <task>");
                runner.loop(task, count !== undefined ? { count } : {});
                status(`Looping${count ? ` ${count}×` : ""}: ${task}`, "loop");
                return;
            }
            case "pursue": {
                const { cap, goal } = parsePursueArg(arg);
                if (!goal) return status("Usage: /pursue [cap] <goal>");
                runner.startPursuit(goal, cap !== undefined ? { cap } : {});
                status(`Pursuing (blind-verified${cap ? `, cap ${cap}` : ""}): ${goal}`, "loop");
                return;
            }
            case "pause":
                presence.setManual("pause");
                return status("Paused.");
            case "resume":
                presence.setManual("resume");
                return status("Resumed.");
            case "stop":
                runner.stop();
                return status("Stopped.");
            case "clear":
                runner.clear();
                return status("Transcript cleared.");
            case "retry":
                return status("Retry: re-send your last task.");
            case "screenshot": {
                const shot = await deps.control.screenshot();
                activeWriter?.write({
                    type: "data-screenshot",
                    data: {
                        toolCallId: `manual-${Date.now()}`,
                        src: `data:${shot.mimeType};base64,${shot.base64}`,
                        width: shot.width,
                        height: shot.height,
                    },
                });
                return;
            }
            case "model":
                if (!arg) return status("Usage: /model <id>");
                runner.setModel(arg);
                return status(`Model set: ${arg}`);
            case "policy":
                if (arg === "risky-only" || arg === "review-all" || arg === "autorun-trusted") {
                    reviewer.setPolicy(arg);
                    return status(`Review policy: ${arg}`);
                }
                return status("Usage: /policy <risky-only|review-all|autorun-trusted>");
            case "autonomy": {
                const n = Number(arg);
                if (arg !== "" && Number.isFinite(n) && n >= 0 && n <= 5) {
                    reviewer.setAutonomy(n);
                    const lvl = reviewer.getAutonomy();
                    settings.patch({ autonomy: lvl });
                    return status(`Autonomy: ${lvl} — ${AUTONOMY_LABELS[lvl].label}.`);
                }
                return status("Usage: /autonomy <0-5> (0 = ask first, 5 = hands-off)");
            }
            case "help":
                return status("Commands:\n" + COMMANDS.map((c) => `/${c.name} ${c.arg ?? ""} — ${c.summary}`).join("\n"));
        }
    }

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let path = url.pathname;

        // Single-token gate (no-op when no token is configured). The login + auth
        // endpoints must stay reachable; everything else needs a valid session.
        const token = settings.get().accessToken;
        if (token && !isLoopback(req) && !isAuthed(req, token) && path !== "/_agent/login" && path !== "/_agent/auth" && path !== "/_agent/logout") {
            if (String(req.headers.accept ?? "").includes("text/html")) {
                res.writeHead(302, { location: "/_agent/login" });
                return res.end();
            }
            return json(res, 401, { error: "Unauthorized" });
        }

        // Default experience: the bare root serves OUR console (better on mobile
        // than the Pi's native UI). The Pi's own UI stays one tap away at
        // `/?native=1`; the desktop shell (its own native view) is never swapped.
        const isDesktopShell = (req.headers.cookie ?? "").includes(`${DESKTOP_SHELL_COOKIE}=desktop`);
        if (req.method === "GET" && path === "/" && url.searchParams.get("native") !== "1" && !isDesktopShell) {
            if (webAssets.serve("console.html", res)) return;
        }

        // Our surface is `/_agent/*` plus `/mcp` (kept at the root so existing
        // external MCP clients keep working). Everything else is the PiKVM target.
        // `/mcp` and `/mcp/<sessionId>` (the session id lets the server enforce the
        // single-controller KVM lease for agents without a permission hook).
        const isMcp = path === "/mcp" || path.startsWith("/mcp/");
        if (!isMcp && path !== "/_agent" && !path.startsWith("/_agent/")) {
            void proxy.handleHttp(req, res);
            return;
        }
        // Strip the namespace so the existing route table matches unchanged.
        if (!isMcp) path = path.slice("/_agent".length) || "/";

        // Auth pages (only meaningful when a token is configured).
        if (path === "/login" && req.method === "GET") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(loginPage(url.searchParams.get("error") === "1", url.searchParams.get("bye") === "1"));
        }
        // Logout: clear the session cookie and return to the login screen.
        if (path === "/logout") {
            res.writeHead(302, {
                location: "/_agent/login?bye=1",
                "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
            });
            return res.end();
        }
        if (path === "/auth" && req.method === "POST") {
            void readBody(req).then((b) => {
                const submitted = new URLSearchParams(b).get("token") ?? "";
                if (token && submitted === token) {
                    res.writeHead(302, {
                        // Land on our own clean console (screen + chat + manual
                        // control), not the Pi's full UI.
                        location: "/_agent/console",
                        "set-cookie": `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`,
                    });
                    return res.end();
                }
                res.writeHead(302, { location: "/_agent/login?error=1" });
                return res.end();
            });
            return;
        }

        // The web/mobile console (live screen + manual keyboard/mouse + chat).
        // `/_agent`, `/_agent/` and `/_agent/console` all land here.
        if (req.method === "GET" && (path === "/" || path === "/console")) {
            if (webAssets.serve("console.html", res)) return;
        }

        // Static agent assets (the UI bundle), served under `/_agent/...`.
        if (req.method === "GET" && webAssets.serve(path, res)) return;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, x-pikvm-mcp-token",
            });
            return res.end();
        }

        if (path === "/mcp" || path.startsWith("/mcp/")) {
            if (!mcpTokenOk(req, url, deps.mcpToken)) return json(res, 401, { error: "Unauthorized MCP client" });
            if (req.method !== "POST") return json(res, 405, { error: "Use POST" });
            const session = path.startsWith("/mcp/") ? decodeURIComponent(path.slice("/mcp/".length)) || undefined : undefined;
            void readBody(req).then((b) => {
                let parsed: unknown;
                try {
                    parsed = b ? JSON.parse(b) : undefined;
                } catch {
                    return json(res, 400, { error: "Invalid JSON" });
                }
                return mcpHandler(req, res, parsed, session);
            });
            return;
        }

        if (path === "/api/state" && req.method === "GET") return json(res, 200, state());

        // GUARDRAIL for Claude Code: its PreToolUse hook posts {tool, args} here before
        // an MCP pikvm action runs. We classify it (sensitive-area vision check + dangerous
        // command + autonomy dial) and return allow | ask | deny, which the hook maps to
        // Claude Code's own permission decision (auto-run / in-terminal prompt / block).
        if (path === "/api/permcheck" && req.method === "POST") {
            void readBody(req).then(async (b) => {
                try {
                    const { tool, args, session } = JSON.parse(b || "{}");
                    const bare = String(tool || "").replace(/^mcp__[a-z0-9-]+__/i, ""); // mcp__pikvm__click → click
                    const result = await runner.assessMcpOp(bare, (args ?? {}) as Record<string, unknown>, session ? String(session) : undefined);
                    return json(res, 200, result);
                } catch {
                    return json(res, 200, { decision: "ask", reason: "permission check failed — confirm manually" });
                }
            });
            return;
        }


        // Live chat broadcast: all clients see every run in real time (the
        // conversation chunks + run framing + user messages). A client loads the
        // transcript snapshot once, then stays live via this stream.
        if (path === "/api/events" && req.method === "GET") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write(": connected\n\n");
            broadcast.add(res);
            const ka = setInterval(() => {
                try {
                    res.write(": ping\n\n");
                } catch {
                    /* closed */
                }
            }, 15000);
            req.on("close", () => clearInterval(ka));
            req.on("error", () => clearInterval(ka));
            return;
        }

        // Agent "X-ray" overlay events (acting / cursor / region / typing / context),
        // streamed so the console can draw them over the live screen (shared by web
        // and desktop). Replays the current acting/context state on connect.
        if (path === "/api/overlay/stream" && req.method === "GET") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write(": connected\n\n");
            const unsub = overlay.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
            const ka = setInterval(() => res.write(": ping\n\n"), 15000);
            const cleanup = () => {
                clearInterval(ka);
                unsub();
            };
            req.on("close", cleanup);
            req.on("error", cleanup);
            return;
        }

        if (path === "/api/chat" && req.method === "POST") {
            void readBody(req).then((b) => {
                let body: any;
                try {
                    body = JSON.parse(b);
                } catch {
                    return json(res, 400, { error: "Invalid JSON" });
                }
                const { text, images } = lastUserMessage(body.messages);
                if (!text && images.length === 0) return json(res, 400, { error: "No user message" });
                // A pre-authorized run (e.g. a user-tapped "suggested action" — the tap
                // is explicit consent) skips per-action approval prompts for this run.
                if (body.trusted === true) runner.setAutoApproveRun(true);
                debugLog.log("user", { text, trusted: body.trusted === true, clientId: body.clientId, images: images.length });
                // Metrics: tag the run that's about to start, and (for a tapped suggestion)
                // record the click with the time-to-click since it was shown.
                const sugId = typeof body.suggestionId === "string" ? body.suggestionId : undefined;
                nextRunMeta = { trigger: sugId ? "suggestion" : "user", task: text || "", ...(sugId ? { suggestion: { id: sugId, title: String(body.suggestionTitle ?? "") } } : {}) };
                if (sugId) {
                    const shownAt = suggestionShownAt.get(sugId);
                    metrics.record("suggestion_tapped", { suggestionId: sugId, title: String(body.suggestionTitle ?? ""), msToClick: shownAt ? Date.now() - shownAt : null, task: text || "" });
                }
                // Tag this run with the sender's id (so it ignores its own echo) and
                // broadcast the user message so spectating clients show it.
                runClientId = typeof body.clientId === "string" ? body.clientId : undefined;
                broadcast.send({
                    type: "user",
                    id: `u-${Date.now()}`,
                    ...(runClientId ? { clientId: runClientId } : {}),
                    text: text || "",
                    images: images.map((im) => ({ url: `data:${im.mimeType};base64,${im.data}` })),
                });
                streamChat(res, text || "(see attached image)", images);
            });
            return;
        }

        if (path === "/api/approve" && req.method === "POST") {
            void readBody(req).then((b) => {
                let body: any;
                try {
                    body = JSON.parse(b);
                } catch {
                    return json(res, 400, { error: "Invalid JSON" });
                }
                const resolve = pendingAuth.get(body.id);
                if (!resolve) return json(res, 404, { error: "Unknown or expired prompt" });
                pendingAuth.delete(body.id);
                pendingAuthReqs.delete(body.id);
                debugLog.log("auth-decision", { id: body.id, decision: body.decision });
                {
                    const shown = authShownAt.get(body.id);
                    authShownAt.delete(body.id);
                    metrics.record("auth_decision", { id: body.id, decision: body.decision, msToDecide: shown ? Date.now() - shown : null });
                }
                resolve({
                    decision: body.decision,
                    ...(body.text ? { text: body.text } : {}),
                    ...(body.rememberKind ? { rememberKind: true } : {}),
                });
                // Deny = STOP. A denied action halts the whole run and hands control
                // back so the user decides what's next — don't let the agent keep
                // trying other actions. Clear the acting overlay immediately so the
                // KVM automation-control panel and the chat agree on one state.
                if (body.decision === "deny") {
                    runner.stop();
                    clearPendingAuths(); // also free ANY other gate parked concurrently (e.g. an MCP-driven one)
                    overlay.emitOverlay({ type: "acting", active: false });
                }
                return json(res, 200, { ok: true });
            });
            return;
        }

        if (path === "/api/policy" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { policy } = JSON.parse(b || "{}");
                if (policy) {
                    reviewer.setPolicy(policy);
                    settings.patch({ policy });
                }
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/presence" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { mode } = JSON.parse(b || "{}");
                if (mode) presence.setManual(mode);
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/stop" && req.method === "POST") {
            metrics.record("user_action", { action: "stop", wasRunning: runner.isStreaming() });
            runner.stop();
            clearPendingAuths(); // a stopped run shouldn't leave a dangling approval prompt
            overlay.emitOverlay({ type: "acting", active: false });
            return json(res, 200, state());
        }
        if (path === "/api/steer" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { text } = JSON.parse(b || "{}");
                    if (text && String(text).trim()) {
                        // Show the steering message inline in the live timeline.
                        activeWriter?.write({ type: "data-steer", data: { text: String(text) } });
                        broadcast.send({ type: "data-steer", data: { text: String(text) } });
                        metrics.record("user_action", { action: "steer", text: String(text).slice(0, 200) });
                        runner.steer(String(text));
                    }
                } catch {
                    /* ignore */
                }
                return json(res, 200, { ok: true });
            });
            return;
        }
        if (path === "/api/pause" && req.method === "POST") {
            metrics.record("user_action", { action: "pause" });
            runner.pauseForUser();
            return json(res, 200, state());
        }
        if (path === "/api/resume" && req.method === "POST") {
            runner.resumeFromUser();
            return json(res, 200, state());
        }

        if (path === "/api/model" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { model } = JSON.parse(b || "{}");
                if (model) {
                    runner.setModel(model);
                    settings.patch({ model });
                }
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/settings" && req.method === "POST") {
            void readBody(req).then((b) => {
                const patch = JSON.parse(b || "{}");
                const next = settings.patch(patch);
                if (typeof patch.humanize === "number") control.setHumanize(next.humanize);
                if (typeof patch.pauseOnPresence === "boolean") presence.setEnabled(next.pauseOnPresence);
                if (typeof patch.wpm === "number") control.setWpm(next.wpm);
                if (typeof patch.autonomy === "number") reviewer.setAutonomy(next.autonomy);
                if (patch.keyboardLayout === "us" || patch.keyboardLayout === "uk") control.setLayout(next.keyboardLayout);
                if (patch.modelRouting) {
                    const mr = next.modelRouting;
                    runner.setRouterModels({ enabled: mr.enabled, reasoningModel: mr.reasoningModel, fastModel: mr.fastModel, subagentModel: mr.subagentModel });
                }
                // The "transcribe" toggle is the master capture-intent switch: turning it
                // on starts the transcriber and emits "capture", which both the native UI
                // (IPC) and the console (ambient-SSE relay) act on to begin recording audio.
                if (typeof patch?.ambient?.transcribe === "boolean") {
                    transcriber.setCapturing(next.ambient.transcribe);
                }
                return json(res, 200, state());
            });
            return;
        }

        // Providers & Models: store (or clear, with an empty value) an API key for
        // a model provider. The key lands in the secrets vault, never in plaintext
        // settings. After saving, role models re-resolve so a newly-keyed provider
        // is immediately usable. (OAuth providers like `codex` use /api/login.)
        if (path === "/api/provider-key" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { provider, key } = JSON.parse(b || "{}");
                    if (typeof provider === "string" && typeof key === "string") {
                        runner.setProviderKey(provider, key);
                    }
                } catch {
                    /* ignore malformed body */
                }
                return json(res, 200, state());
            });
            return;
        }

        // Secrets vault: set/delete by name. Values are write-only — never read back
        // to the client or the agent; the server only ever exposes the names.
        if (path === "/api/secrets" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { name, value, hint } = JSON.parse(b || "{}");
                    if (typeof name === "string" && name.trim()) {
                        if (typeof value === "string" && value.length) secrets.set(name, value, typeof hint === "string" ? hint : undefined);
                        else if (typeof hint === "string") secrets.setHint(name, hint); // edit the note without touching the value
                    }
                } catch {
                    /* ignore */
                }
                return json(res, 200, state());
            });
            return;
        }
        // Reveal a secret's value to the USER's own settings UI (never to the agent's
        // context). Gated by the same access control as the rest of the API.
        if (path === "/api/secrets/reveal" && req.method === "POST") {
            void readBody(req).then((b) => {
                let value: string | undefined;
                try {
                    const { name } = JSON.parse(b || "{}");
                    if (typeof name === "string") {
                        value = secrets.get(name);
                        debugLog.log("secret-reveal", { name }); // log the access, not the value
                    }
                } catch {
                    /* ignore */
                }
                return json(res, 200, { value: value ?? null });
            });
            return;
        }
        if (path === "/api/secrets/delete" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { name } = JSON.parse(b || "{}");
                    if (typeof name === "string") secrets.delete(name);
                } catch {
                    /* ignore */
                }
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/ambient/clear" && req.method === "POST") {
            ambientEvents.length = 0;
            return json(res, 200, state());
        }
        // Dismiss a suggested action (hide it until the screen state changes).
        if (path === "/api/suggestions/dismiss" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const id = String(JSON.parse(b || "{}").id ?? "");
                    if (id) suggestions.dismiss(id);
                } catch {
                    /* ignore */
                }
                json(res, 200, { ok: true });
            });
            return;
        }
        // Manual start/stop of meeting transcription, independent of auto-detection.
        if (path === "/api/ambient/transcribe" && req.method === "POST") {
            void readBody(req).then((b) => {
                let on = false;
                try {
                    on = !!JSON.parse(b || "{}").on;
                } catch {
                    /* default off */
                }
                if (on) transcriber.clear();
                transcriber.setCapturing(on);
                return json(res, 200, state());
            });
            return;
        }
        // Audio ingest from the console's own capture (web + desktop). The console
        // records the live WebRTC audio in short complete-webm chunks and POSTs the
        // base64 here; we feed them straight into the whisper pipeline. Only accepted
        // while capture is actually requested (transcriber active) — a stray POST after
        // the toggle is off is ignored. This is what makes transcription work in the
        // console, where the legacy native-UI audio capture path doesn't run.
        if (path === "/api/transcribe/audio" && req.method === "POST") {
            void readBody(req).then((b) => {
                if (transcriber.isActive() && b) {
                    transcriber.setCaptureStatus({ remote: true, mic: false, error: null });
                    try {
                        transcriber.pushAudio(Buffer.from(b, "base64"));
                    } catch {
                        /* ignore malformed chunk */
                    }
                }
                res.writeHead(204).end();
            });
            return;
        }
        // Past meetings log.
        if (path === "/api/meetings" && req.method === "GET") return json(res, 200, { meetings: meetingLog.list() });
        if (path === "/api/meetings/get" && req.method === "POST") {
            void readBody(req).then((b) => {
                let id = "";
                try {
                    id = String(JSON.parse(b || "{}").id ?? "");
                } catch {
                    /* none */
                }
                return json(res, 200, { meeting: meetingLog.get(id) ?? null });
            });
            return;
        }
        if (path === "/api/ambient/test" && req.method === "POST") {
            void ntfy
                .notify("Test notification from the PiKVM ambient monitor.", { title: "PiKVM", priority: "default", tags: "white_check_mark" })
                .then((r) => json(res, 200, { ok: r.sent, reason: r.reason }))
                .catch(() => json(res, 200, { ok: false }));
            return;
        }
        // Live trace of the ambient monitor's decisions (SSE) for the console.
        if (path === "/api/ambient/stream" && req.method === "GET") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write(": connected\n\n");
            const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
            const onTrace = (t: unknown) => send(t);
            const onEvent = (e: AmbientEvent) => send({ ts: e.ts, level: "event", text: `${e.kind}: ${e.title}` });
            const onSeg = (text: string) => send({ ts: Date.now(), level: "transcript", text });
            const onSug = (sug: { ts: number; text: string }) => send({ ts: sug.ts, level: "suggestion", text: sug.text });
            // Tell the console whether to capture-and-POST its audio. Emitted on every
            // capture toggle, plus once on connect for the current state (so a console
            // that opens after transcription was enabled starts recording).
            const onCap = (on: boolean) => send({ level: "transcribe", on });
            ambient.on("trace", onTrace);
            ambient.on("event", onEvent);
            ambient.on("suggestion", onSug);
            transcriber.on("segment", onSeg);
            transcriber.on("capture", onCap);
            send({ level: "transcribe", on: settings.get().ambient.transcribe });
            const ka = setInterval(() => res.write(": ping\n\n"), 15000);
            const cleanup = () => {
                clearInterval(ka);
                ambient.off("trace", onTrace);
                ambient.off("event", onEvent);
                ambient.off("suggestion", onSug);
                transcriber.off("segment", onSeg);
                transcriber.off("capture", onCap);
            };
            req.on("close", cleanup);
            req.on("error", cleanup);
            return;
        }
        // On-demand meeting copilot nudge / answer a question.
        if (path === "/api/ambient/suggest" && req.method === "POST") {
            void readBody(req).then((b) => {
                let question: string | undefined;
                try {
                    const q = JSON.parse(b || "{}").question;
                    if (typeof q === "string" && q.trim()) question = q.trim();
                } catch {
                    /* none */
                }
                runner.meetingAsk(question);
                json(res, 200, { ok: runner.isInMeeting(), reason: runner.isInMeeting() ? undefined : "no active meeting" });
            });
            return;
        }
        // Force a triage of the current screen right now (bypasses the change gate).
        if (path === "/api/ambient/check" && req.method === "POST") {
            void ambient
                .forceTriage()
                .then((r) => json(res, 200, r))
                .catch((e) => json(res, 200, { ok: false, reason: String(e?.message ?? e) }));
            return;
        }
        // Force the meeting state on/off (tests the brief + transcription path).
        if (path === "/api/ambient/meeting" && req.method === "POST") {
            void readBody(req).then((b) => {
                let on = true;
                try {
                    on = !!JSON.parse(b || "{}").on;
                } catch {
                    /* default on */
                }
                void ambient.forceMeeting(on).then(() => json(res, 200, state()));
            });
            return;
        }

        if (path === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: state().sessions });

        // Current session's full UI transcript (with screenshots) — for restore on load.
        if (path === "/api/sessions/current" && req.method === "GET")
            return json(res, 200, { messages: runner.currentUiMessages() });

        if (path === "/api/sessions/ui" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { messages, sessionId } = JSON.parse(b || "{}");
                    // Reject a save tagged for a session we've already switched away from —
                    // otherwise a trailing persist of the PREVIOUS chat lands in the new one
                    // (the "+ new chat then it shows the old conversation" bug).
                    if (Array.isArray(messages) && !isStaleUiSave(sessionId, runner.currentSessionId())) {
                        runner.saveUiMessages(messages);
                        // The client that owns a run persists the transcript after it
                        // settles. Notify OTHER clients to reload — a spectator (e.g. a
                        // phone that joined mid-run) has no other way to get the finished
                        // conversation, since saveUiMessages alone doesn't bump uiVersion.
                        // Gated on >1 client so a lone client never reloads its own save.
                        if (broadcast.count() > 1) bumpUi();
                    }
                } catch {
                    /* ignore */
                }
                return json(res, 200, { ok: true });
            });
            return;
        }

        if (path === "/api/sessions/new" && req.method === "POST") {
            runner.newSession(); // stops the current run internally…
            clearPendingAuths(); // …so free any approval gate it left parked
            return json(res, 200, { ...state(), messages: [] });
        }

        if (path === "/api/sessions/resume" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { id } = JSON.parse(b || "{}");
                const messages = id ? runner.resumeSession(id) : [];
                clearPendingAuths();
                return json(res, 200, { ...state(), messages });
            });
            return;
        }

        if (path === "/api/schedules/cancel" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { id } = JSON.parse(b || "{}");
                    if (id) runner.cancelSchedule(id);
                } catch {
                    /* ignore */
                }
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/sessions/delete" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { id } = JSON.parse(b || "{}");
                if (id) runner.deleteSession(id);
                return json(res, 200, state());
            });
            return;
        }

        if (path === "/api/login" && req.method === "POST") {
            void auth
                .login({ onAuth: ({ url }) => openExternal(url) })
                .then(() => json(res, 200, { ok: true, loggedIn: true }))
                .catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
            return;
        }

        json(res, 404, { error: "Not found" });
    });

    // The shared terminal lives on a WebSocket: every device subscribes and drives the same
    // server-hosted Claude Code sessions. Handled here; everything else proxies to PiKVM.
    const termWss = new WebSocketServer({ noServer: true });
    termWss.on("connection", (ws) => {
        const sessions = deps.terminalSessions;
        if (!sessions) return ws.close();
        sessions.ensurePrimary();
        const send = (msg: unknown) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        };
        const unsub = sessions.subscribe(send);
        ws.on("message", (raw) => {
            let msg: ClientMsg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            sessions.handle(msg, send);
        });
        ws.on("close", unsub);
        ws.on("error", unsub);
    });

    // PiKVM uses WebSockets for HID and stream-info; proxy every upgrade to it
    // (subject to the same token gate as HTTP).
    server.on("upgrade", (req, socket, head) => {
        const token = settings.get().accessToken;
        if (token && !isLoopback(req) && !isAuthed(req, token)) {
            socket.destroy();
            return;
        }
        // Our shared-terminal channel (mounted at /_agent/terminal and the bare /terminal).
        const upgradePath = (req.url || "").split("?")[0];
        if (upgradePath === "/_agent/terminal" || upgradePath === "/terminal") {
            termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit("connection", ws, req));
            return;
        }
        void proxy.handleUpgrade(req, socket, head);
    });

    server.listen(port, host);
    return server;
}
