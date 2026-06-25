/**
 * Headless entry point — boots the SAME control server + agent runner + PiKVM
 * reverse proxy as the desktop app, but with plain-Node implementations of every
 * dependency that was previously Electron-backed. No `BrowserWindow`, `Tray`,
 * `safeStorage`, `nativeImage`, `globalShortcut`, IPC or native overlay.
 *
 * Run it on a homelab server and point the desktop app (or any browser) at it as
 * a thin client. It serves the agent UI (`/_agent/sidebar.html`) + the agent API
 * and reverse-proxies everything else to the PiKVM target, exactly like the
 * in-Electron server.
 *
 * Configuration (all via env):
 *   PIKVM_ORIGIN         PiKVM base URL, e.g. https://user:pass@pikvm/  (REQUIRED
 *                        unless a saved pikvm.json exists in the data dir)
 *   PIKVM_BIND_HOST      Interface to bind (default 0.0.0.0 — LAN-reachable)
 *   PIKVM_CONTROL_PORT   Port to listen on (default 25650)
 *   PIKVM_DATA_DIR       Where vaults/sessions/keys live (default the Electron
 *                        userData path: ~/.config/pikvm-desktop-agentic). Sharing
 *                        it with a desktop install lets them reuse sessions/memory,
 *                        but NOT the secrets vault (different crypto — see below).
 *
 * SECRETS: the desktop encrypts the vault with the OS keychain (`safeStorage`);
 * headless uses an AES-256-GCM keyfile (`agent-secrets.key`, 0600) in the data
 * dir. The two formats are NOT interchangeable, so a desktop vault won't decrypt
 * here (and vice-versa) — re-enter secrets on the headless host, or keep its data
 * dir separate.
 *
 * SCREEN CAPTURE: the desktop grabs the already-rendered live view; headless has
 * no renderer, so `control.captureScreen`/`captureFingerprint` are left unset and
 * the control core falls back to the PiKVM `/api/streamer/snapshot` endpoint.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

import { PiKvmControl } from "./pikvm-control";
import { sharpImageOps } from "./image-ops-sharp";
import { OperationReviewer } from "./reviewer";
import { PresenceMonitor } from "./presence";
import { CodexAuth } from "./agent/auth";
import { AgentRunner } from "./agent/runner";
import { connectAtlas } from "./agent/atlas-mcp";
import { startControlServer } from "./server";
import { createCaptureDocument } from "./doc-capture";
import { OverlayBus } from "./overlay-bus";
import { SettingsStore } from "./settings";
import { InputTracker } from "./input-tracker";
import { SecretsStore } from "./secrets";
import { keyfileSecretCrypto } from "./secret-crypto-keyfile";
import { NtfyClient } from "./ambient/ntfy";
import { AmbientMonitor } from "./ambient/monitor";
import { SuggestionWatcher } from "./ambient/suggestions";
import { Transcriber } from "./ambient/transcriber";
import { MeetingLog } from "./ambient/meeting-log";

/** Default control port — matches the desktop app's CONTROL_PORT. */
const DEFAULT_CONTROL_PORT = 25650;

/**
 * Data directory. Defaults to the same path Electron uses for `userData` on
 * Linux so an operator CAN point at an existing install if they want, but is
 * overridable for a dedicated headless deployment.
 */
function dataDir(): string {
    const fromEnv = process.env.PIKVM_DATA_DIR?.trim();
    if (fromEnv) return resolve(fromEnv);
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const base = xdg ? resolve(xdg) : resolve(homedir(), ".config");
    return resolve(base, "pikvm-desktop-agentic");
}

/** Resolve the PiKVM origin from env, falling back to a saved pikvm.json. */
function resolveOrigin(dir: string): string {
    const fromEnv = process.env.PIKVM_ORIGIN?.trim();
    const configPath = resolve(dir, "pikvm.json");
    if (fromEnv) {
        // Persist so a later restart works without the env var.
        try {
            writeFileSync(configPath, JSON.stringify({ origin: fromEnv.replace(/\/$/, "") }, null, 2));
        } catch {
            /* best-effort */
        }
        return fromEnv;
    }
    if (existsSync(configPath)) {
        try {
            const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
            if (typeof cfg.origin === "string" && cfg.origin) return cfg.origin;
        } catch {
            /* fall through to the error below */
        }
    }
    throw new Error(
        "No PiKVM origin configured. Set PIKVM_ORIGIN (e.g. https://user:pass@pikvm/) " +
            `or place a pikvm.json with an \"origin\" in ${dir}.`,
    );
}

function main(): void {
    // PiKVM ships a self-signed cert; ignore cert errors process-wide (the desktop
    // does the same via Electron's command-line switch). Scoped to this process.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const dir = dataDir();
    mkdirSync(dir, { recursive: true });

    const origin = resolveOrigin(dir);
    const bindHost = process.env.PIKVM_BIND_HOST?.trim() || "0.0.0.0";
    const port = Number(process.env.PIKVM_CONTROL_PORT) || DEFAULT_CONTROL_PORT;

    const settings = new SettingsStore(resolve(dir, "agent-settings.json"));

    // Control core. Credentials come from the origin URL (user:pass@host) — there
    // is no logged-in browser session to borrow a cookie from in headless mode.
    // Screen capture deliberately left unset → falls back to the Pi snapshot.
    const control = new PiKvmControl({ origin }, sharpImageOps);

    const inputTracker = new InputTracker();
    control.onAgentInput = (info) => {
        if (info.text) inputTracker.appendText("agent", info.text);
        else if (info.key) inputTracker.applyKey("agent", info.key);
    };

    const reviewer = new OperationReviewer();
    const presence = new PresenceMonitor();
    presence.start();

    const auth = new CodexAuth(resolve(dir, "pi-credentials.json"));
    auth.load();

    // Secrets sealed with an AES-256-GCM keyfile (no OS keychain headless).
    const secrets = new SecretsStore(resolve(dir, "agent-secrets.json"), keyfileSecretCrypto(resolve(dir, "agent-secrets.key")));

    const ntfy = new NtfyClient({
        config: () => settings.get().ambient.ntfy,
        getToken: () => secrets.get("ntfy_token"),
    });

    const transcriber = new Transcriber();
    const meetingLog = new MeetingLog(resolve(dir, "agent-meetings.json"));

    const runner = new AgentRunner({
        control,
        reviewer,
        presence,
        auth,
        sessionsDir: resolve(dir, "agent-sessions"),
        inputTracker,
        secrets,
        notify: (message, opts) => ntfy.notify(message, opts),
        getTranscript: () => transcriber.getTranscript(),
        getMeetings: () => meetingLog.recent(8),
    });

    // Atlas memory vault (best effort, async) — identical to the desktop wiring.
    const atlasCfg = settings.get().atlas;
    if (atlasCfg.enabled) {
        void connectAtlas({ atlasBin: atlasCfg.binPath, vault: atlasCfg.vaultPath }).then((bridge) => {
            if (!bridge) return;
            runner.addTools(bridge.tools);
            runner.setMemoryMirror((m) => void bridge.remember(m.text, m.tags, m.id));
        });
    }

    // Ambient monitor. Headless has no "is the KVM window visible" notion, so the
    // screen is always considered watchable (isOnKVM → true). Capture sources are
    // unset on `control`, so the monitor uses the Pi snapshot for change detection.
    const ambient = new AmbientMonitor({
        control,
        presence,
        ntfy,
        settings: () => settings.get().ambient,
        isOnKVM: () => true,
        quickLook: (image, instruction, opts) => runner.quickLook(image, instruction, opts),
        getTranscript: () => transcriber.getTranscript(),
    });
    ambient.start();

    // Proactive "suggested actions" watcher (headless: the KVM is always watchable).
    const suggestions = new SuggestionWatcher({
        control,
        isOnKVM: () => true,
        isBusy: () => runner.isStreaming() || ambient.isInMeeting(),
        enabled: () => settings.get().ambient.suggest,
        look: (image, instruction, opts) => runner.quickLook(image, instruction, opts),
        model: settings.get().ambient.triageModel,
    });
    suggestions.start();

    // Meeting copilot wiring (same as desktop; the overlay is just absent).
    runner.onMeetingOutput = (kind, text) => {
        if (kind === "suggestion") ambient.pushSuggestion(text);
        else ambient.pushTrace(text, "activity");
    };
    ambient.on("event", (e: { kind: string }) => {
        if (e.kind === "meeting-start") {
            if (settings.get().ambient.meetingAssist) runner.startMeeting();
        } else if (e.kind === "meeting-end") {
            runner.endMeeting();
        }
    });
    transcriber.on("segment", (text: string) => runner.meetingObserve(text));

    // Apply persisted preferences (mirrors main.ts).
    const s = settings.get();
    runner.setModel(s.model);
    reviewer.setPolicy(s.policy);
    control.setHumanize(s.humanize);
    control.setWpm(s.wpm);
    control.setLayout(s.keyboardLayout, { source: "auto" }); // let the Pi's hid_keymaps refine this saved default
    presence.setEnabled(s.pauseOnPresence);
    if (s.goal) runner.setGoal(s.goal);

    // Overlay bus: the X-ray/context/region boxes the web console draws. There is no
    // native overlay window headless, so we fan the runner's events to the bus only
    // (the desktop additionally mirrors them into a transparent Electron overlay).
    const overlay = new OverlayBus();
    control.onTypingEvent = (ev) => {
        const dims = control.getDimensions();
        overlay.emitOverlay({ type: "typing", ...ev, w: dims.width, h: dims.height });
    };
    control.onMousePath = (payload) => {
        overlay.emitOverlay({ type: "mouse_path", ...payload });
    };
    runner.onContext = (ctx) => {
        overlay.emitOverlay({ type: "context", ...(ctx as { app?: string; sensitive?: boolean }) });
    };
    runner.onRegions = (result) => {
        overlay.emitOverlay({
            type: "regions",
            regions: result.regions.map((r) => ({ label: r.label, kind: r.kind, x: r.bbox.x, y: r.bbox.y, width: r.bbox.width, height: r.bbox.height })),
            w: result.width,
            h: result.height,
        });
    };
    // After a full-frame screenshot the screen is settled — the cheap moment to
    // (re)segment regions (the runner's grid gate decides if a model call is warranted).
    runner.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "screenshot") {
            const args = (event as { args?: { region?: { x?: number } } }).args ?? {};
            if (!(args.region && typeof args.region.x === "number")) runner.maybeSegmentRegions();
        }
    });

    startControlServer(
        {
            control,
            reviewer,
            presence,
            auth,
            runner,
            settings,
            secrets,
            ambient,
            suggestions,
            ntfy,
            transcriber,
            meetingLog,
            overlay,
            ...runner.visionDeps(), // getRegions/opticalRead/opticalReadStrong/remember for the MCP server
            onFullScreenshot: () => runner.maybeSegmentRegions(),
            // No desktop shell to hand an OAuth URL to — print it so the operator
            // can open it manually on the headless host.
            openExternal: (u) => console.log(`[auth] open this URL to continue:\n  ${u}`),
            captureDocument: createCaptureDocument({
                python: process.env.PIKVM_DOCCAPTURE_PYTHON || "python3",
                script: resolve(__dirname, "doc-capture", "capture.py"),
                target: () => control.captureTarget(),
                outBase: process.env.PIKVM_DOCCAPTURE_OUT || resolve(dir, "doc-captures"),
            }),
        },
        port,
        bindHost,
    );

    console.log(`PiKVM headless backend listening on http://${bindHost}:${port}`);
    console.log(`  agent UI : http://${bindHost}:${port}/_agent/sidebar.html`);
    console.log(`  proxy    : everything else → ${new URL(origin).origin}`);
    console.log(`  data dir : ${dir}`);

    // Keep the process alive and shut down cleanly on signals.
    const shutdown = (sig: string) => {
        console.log(`\n${sig} received — shutting down.`);
        try {
            control.dispose();
        } catch {
            /* ignore */
        }
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
    main();
} catch (err) {
    console.error("Failed to start headless backend:", err instanceof Error ? err.message : err);
    process.exit(1);
}
