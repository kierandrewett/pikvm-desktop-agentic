/**
 * Local control server (127.0.0.1).
 *
 * Hosts two things on one port:
 *  - /mcp        : the integrated MCP server (external clients drive the KVM)
 *  - /api/*      : the sidebar bridge (chat stream, approvals, state, login)
 *
 * The chat stream speaks the Vercel AI SDK UI message protocol so the React
 * sidebar's `useChat` can consume it directly.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import { AgentRunner } from "./agent/runner";
import { OperationReviewer, type Verdict } from "./reviewer";
import { PresenceMonitor } from "./presence";
import { CodexAuth } from "./agent/auth";
import { createMcpHttpHandler, type McpDeps } from "./mcp-server";
import { bridgeAgentEvents } from "./agent/ui-stream";
import type { PiKvmUIMessage, ServerState } from "./agent/protocol";
import { parseCommand, parseLoopArg, COMMANDS } from "./commands";
import type { SettingsStore } from "./settings";
import type { SecretsStore } from "./secrets";
import type { AmbientMonitor } from "./ambient/monitor";
import type { NtfyClient } from "./ambient/ntfy";
import type { Transcriber } from "./ambient/transcriber";
import type { AmbientEvent } from "./agent/protocol";

export interface ServerDeps extends McpDeps {
    runner: AgentRunner;
    auth: CodexAuth;
    settings: SettingsStore;
    secrets: SecretsStore;
    ambient: AmbientMonitor;
    ntfy: NtfyClient;
    transcriber: Transcriber;
    openExternal: (url: string) => void;
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

export function startControlServer(deps: ServerDeps, port: number): ReturnType<typeof createServer> {
    const { runner, reviewer, presence, auth, settings, secrets, ambient, ntfy, transcriber, control, openExternal } = deps;
    const mcpHandler = createMcpHttpHandler(deps);

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
    // Clear stale suggestions when a meeting ends.
    ambient.on("event", (e: AmbientEvent) => {
        if (e.kind === "meeting-end") ambientSuggestions = [];
    });

    // Active chat stream writer (present while a run streams) so reviewer prompts
    // and presence changes can surface as data parts in real time.
    let activeWriter: Writer | undefined;

    // Bumped whenever an autonomous (scheduled) run updates the saved transcript,
    // so an idle sidebar knows to reload and show the flow.
    let uiVersion = 0;
    runner.onUiChanged = () => {
        uiVersion++;
    };

    // Pending authorization prompts awaiting an /api/approve response.
    const pendingAuth = new Map<string, (v: Verdict) => void>();
    reviewer.setPrompter((req) => {
        return new Promise<Verdict>((resolve) => {
            pendingAuth.set(req.id, resolve);
            activeWriter?.write({ type: "data-auth", id: req.id, data: { request: req } });
        });
    });

    presence.on("change", (s) => {
        activeWriter?.write({
            type: "data-status",
            data: { kind: "presence", paused: s.paused, text: s.reason ?? "Resumed." },
        });
    });

    const state = (): ServerState => ({
        policy: reviewer.getPolicy(),
        presence: (() => {
            const p = presence.getState();
            return p.reason ? { paused: p.paused, reason: p.reason } : { paused: p.paused };
        })(),
        ...(runner.getGoal() ? { goal: runner.getGoal()! } : {}),
        loggedIn: auth.isLoggedIn(),
        streaming: runner.isStreaming(),
        acting: runner.isStreaming(),
        pausedForUser: runner.isPausedForUser(),
        model: runner.getModelId(),
        models: runner.availableModels(),
        context: runner.contextInfo(),
        uiVersion,
        pendingAuthIds: Array.from(pendingAuth.keys()),
        ambient: (() => {
            const a = settings.get().ambient;
            return {
                enabled: a.enabled,
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
            return { humanize: s.humanize, pauseOnPresence: s.pauseOnPresence, wpm: s.wpm };
        })(),
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
            case "help":
                return status("Commands:\n" + COMMANDS.map((c) => `/${c.name} ${c.arg ?? ""} — ${c.summary}`).join("\n"));
        }
    }

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
            });
            return res.end();
        }

        if (path === "/mcp") {
            if (req.method !== "POST") return json(res, 405, { error: "Use POST" });
            void readBody(req).then((b) => {
                let parsed: unknown;
                try {
                    parsed = b ? JSON.parse(b) : undefined;
                } catch {
                    return json(res, 400, { error: "Invalid JSON" });
                }
                return mcpHandler(req, res, parsed);
            });
            return;
        }

        if (path === "/api/state" && req.method === "GET") return json(res, 200, state());

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
                resolve({
                    decision: body.decision,
                    ...(body.text ? { text: body.text } : {}),
                    ...(body.rememberKind ? { rememberKind: true } : {}),
                });
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
            runner.stop();
            return json(res, 200, state());
        }
        if (path === "/api/steer" && req.method === "POST") {
            void readBody(req).then((b) => {
                try {
                    const { text } = JSON.parse(b || "{}");
                    if (text && String(text).trim()) {
                        // Show the steering message inline in the live timeline.
                        activeWriter?.write({ type: "data-steer", data: { text: String(text) } });
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
                    if (typeof name === "string" && name.trim() && typeof value === "string")
                        secrets.set(name, value, typeof hint === "string" ? hint : undefined);
                } catch {
                    /* ignore */
                }
                return json(res, 200, state());
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
            ambient.on("trace", onTrace);
            ambient.on("event", onEvent);
            ambient.on("suggestion", onSug);
            transcriber.on("segment", onSeg);
            const ka = setInterval(() => res.write(": ping\n\n"), 15000);
            const cleanup = () => {
                clearInterval(ka);
                ambient.off("trace", onTrace);
                ambient.off("event", onEvent);
                ambient.off("suggestion", onSug);
                transcriber.off("segment", onSeg);
            };
            req.on("close", cleanup);
            req.on("error", cleanup);
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
                    const { messages } = JSON.parse(b || "{}");
                    if (Array.isArray(messages)) runner.saveUiMessages(messages);
                } catch {
                    /* ignore */
                }
                return json(res, 200, { ok: true });
            });
            return;
        }

        if (path === "/api/sessions/new" && req.method === "POST") {
            runner.newSession();
            return json(res, 200, { ...state(), messages: [] });
        }

        if (path === "/api/sessions/resume" && req.method === "POST") {
            void readBody(req).then((b) => {
                const { id } = JSON.parse(b || "{}");
                const messages = id ? runner.resumeSession(id) : [];
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

    server.listen(port, "127.0.0.1");
    return server;
}
