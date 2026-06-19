import {
    app,
    BrowserWindow,
    WebContentsView,
    ipcMain,
    shell,
    screen,
    dialog,
    nativeTheme,
    session,
    Notification,
    clipboard,
    Menu,
    Rectangle,
} from "electron";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { url } from "inspector/promises";
import { resolve } from "path";
import { PiKvmControl } from "./pikvm-control";
import { OperationReviewer } from "./reviewer";
import { PresenceMonitor } from "./presence";
import { CodexAuth } from "./agent/auth";
import { AgentRunner } from "./agent/runner";
import { connectAtlas } from "./agent/atlas-mcp";
import { startControlServer } from "./server";
import { SettingsStore } from "./settings";
import { InputTracker } from "./input-tracker";
import { SecretsStore } from "./secrets";
import { NtfyClient } from "./ambient/ntfy";
import { AmbientMonitor } from "./ambient/monitor";
import { Transcriber } from "./ambient/transcriber";
import { MeetingLog } from "./ambient/meeting-log";

const staticPath = resolve(__dirname, "static");
const appIconPath = resolve(__dirname, "assets/icon.png");

// Friendly product name — drives the dock tooltip / WM_CLASS and the about
// panel. Without this, Linux falls back to the package name
// ("pikvm-desktop-agentic") and a generic icon.
app.setName("PiKVM Desktop");

/** Port for the local control server (MCP + sidebar chat bridge). */
const CONTROL_PORT = 25650;
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 640;

/** A readable phrase for the overlay describing the current agent action. */
function humanAction(tool: string, args: any): string {
    switch (tool) {
        case "type_text":
            return `typing "${String(args?.text ?? "").slice(0, 40)}"…`;
        case "move_mouse":
            return "moving the mouse…";
        case "click":
            return "clicking…";
        case "double_click":
            return "double-clicking…";
        case "press_key":
            return `pressing ${args?.key ?? "a key"}…`;
        case "hotkey":
            return `pressing ${(args?.codes ?? []).join("+")}…`;
        case "scroll":
            return "scrolling…";
        case "screenshot":
            return "looking at the screen…";
        default:
            return "performing actions…";
    }
}

/** Start the agentic backend (control core, reviewer, presence, agent, servers). */
function startAgentBackend(origin: string, settings: SettingsStore, inputTracker: InputTracker) {
    const control = new PiKvmControl({
        origin,
        // Reuse the logged-in PiKVM web session so the agent's snapshot/HID
        // requests are authorized even when credentials aren't in the URL.
        getCookie: async () => {
            try {
                const cookies = await session.defaultSession.cookies.get({ name: "auth_token" });
                return cookies[0]?.value;
            } catch {
                return undefined;
            }
        },
    });
    // Feed the agent's own keystrokes into the unified input tracker.
    control.onAgentInput = (info) => {
        if (info.text) inputTracker.appendText("agent", info.text);
        else if (info.key) inputTracker.applyKey("agent", info.key);
    };
    const reviewer = new OperationReviewer();
    const presence = new PresenceMonitor();
    presence.start();
    const auth = new CodexAuth(resolve(app.getPath("userData"), "pi-credentials.json"));
    auth.load();
    const secrets = new SecretsStore(resolve(app.getPath("userData"), "agent-secrets.json"));
    // ntfy push (token from the secrets vault) — created before the runner so the
    // agent's notify_user tool can use it.
    const ntfy = new NtfyClient({
        config: () => settings.get().ambient.ntfy,
        getToken: () => secrets.get("ntfy_token"),
    });
    const transcriber = new Transcriber();
    const meetingLog = new MeetingLog(resolve(app.getPath("userData"), "agent-meetings.json"));
    const runner = new AgentRunner({
        control,
        reviewer,
        presence,
        auth,
        sessionsDir: resolve(app.getPath("userData"), "agent-sessions"),
        inputTracker,
        secrets,
        notify: (message, opts) => ntfy.notify(message, opts),
        getTranscript: () => transcriber.getTranscript(),
        getMeetings: () => meetingLog.recent(8),
    });

    // Connect the Atlas memory vault (markdown memory via its MCP server). Best
    // effort and async: if Atlas is missing the agent still runs with JSON memory.
    const atlasCfg = settings.get().atlas;
    if (atlasCfg.enabled) {
        void connectAtlas({ atlasBin: atlasCfg.binPath, vault: atlasCfg.vaultPath }).then((bridge) => {
            if (!bridge) return;
            runner.addTools(bridge.tools);
            // Hook: every `remember` (and recap save) write-throughs into Atlas.
            runner.setMemoryMirror((m) => void bridge.remember(m.text, m.tags, m.id));
        });
    }

    // Ambient background monitor.
    let onKVM = false;
    const ambient = new AmbientMonitor({
        control,
        presence,
        ntfy,
        settings: () => settings.get().ambient,
        isOnKVM: () => onKVM,
        quickLook: (image, instruction, opts) => runner.quickLook(image, instruction, opts),
        getTranscript: () => transcriber.getTranscript(),
    });
    ambient.start();

    // The live meeting copilot is a real Pi agent (tools: screen, transcript, web,
    // memory). It briefs + suggests; the monitor only detects the meeting and feeds it.
    runner.onMeetingOutput = (kind, text) => {
        if (kind === "suggestion") ambient.pushSuggestion(text);
        else ambient.pushTrace(text, "activity");
    };
    ambient.on("event", (e: { kind: string }) => {
        if (e.kind === "meeting-start") {
            if (settings.get().ambient.meetingAssist) runner.startMeeting();
        } else if (e.kind === "meeting-end") {
            runner.endMeeting(); // final recap + remember action items, then tear down
        }
    });
    // Feed each new transcript chunk to the copilot agent (it accumulates + self-throttles).
    transcriber.on("segment", (text: string) => runner.meetingObserve(text));

    // Apply persisted preferences.
    const s = settings.get();
    runner.setModel(s.model);
    reviewer.setPolicy(s.policy);
    control.setHumanize(s.humanize);
    control.setWpm(s.wpm);
    control.setLayout(s.keyboardLayout);
    presence.setEnabled(s.pauseOnPresence);
    if (s.goal) runner.setGoal(s.goal);

    // Bind to the LAN only when the user opts in (so a phone/browser can reach
    // the proxy); default to loopback. Auth gating lands in a later phase.
    const bindHost = settings.get().bindHost || "127.0.0.1";
    startControlServer(
        { control, reviewer, presence, auth, runner, settings, secrets, ambient, ntfy, transcriber, meetingLog, openExternal: (u) => void shell.openExternal(u) },
        CONTROL_PORT,
        bindHost,
    );
    console.log(`Agent backend listening on http://${bindHost}:${CONTROL_PORT} (UI proxy + /_agent/*)`);
    return { control, reviewer, presence, auth, runner, ambient, transcriber, settings, setOnKVM: (b: boolean) => { onKVM = b; } };
}

const configPath = resolve(app.getPath("userData"), "pikvm.json");
function loadConfig() {
    if (!existsSync(configPath)) {
        const cfg = { origin: "https://pikvm/" };
        writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        return cfg;
    }
    return JSON.parse(readFileSync(configPath, "utf-8"));
}
function saveConfig(cfg: any) {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

/** Standard editing context menu (cut/copy/paste/select all) for a view. */
function attachContextMenu(wc: Electron.WebContents, opts: { conversation?: boolean } = {}) {
    wc.on("context-menu", (_e, params) => {
        const f = params.editFlags;
        const template: Electron.MenuItemConstructorOptions[] = [];
        if (params.isEditable) {
            template.push(
                { role: "cut", enabled: f.canCut },
                { role: "copy", enabled: f.canCopy },
                { role: "paste", enabled: f.canPaste },
                { type: "separator" },
                { role: "selectAll" }
            );
        } else if (params.selectionText) {
            template.push({ role: "copy" }, { role: "selectAll" });
        }
        if (opts.conversation) {
            if (template.length) template.push({ type: "separator" });
            template.push({ label: "Copy conversation", click: () => wc.send("copy-conversation") });
        }
        if (template.length) Menu.buildFromTemplate(template).popup();
    });
}

function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    let origin = config.origin;

    const kvmSize = { width: 1280, height: 720 };
    const normalSize = { width: 400, height: 350 };
    const settingsSize = { width: 400, height: 110 };
    const TITLEBAR_HEIGHT = 38;

    const win = new BrowserWindow({
        width: normalSize.width,
        height: normalSize.height,
        darkTheme: true,
        frame: false,
        icon: appIconPath,
        title: "PiKVM Desktop",
        minWidth: 300,
        minHeight: 80,
        backgroundColor: "#0f0f14",
    });

    const mainView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload.js"),
        },
    });

    const overlayView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-ui.js"),
        },
    });

    const sidebarView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-sidebar.js"),
        },
    });

    // Transparent overlay over the KVM, shown while the agent is controlling the
    // target — gives the user a big "stop & take control" button (Claude-style).
    const controlOverlayView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-sidebar.js"),
        },
    });
    controlOverlayView.setBackgroundColor("#00000000");
    controlOverlayView.setVisible(false);

    // Floating, draggable meeting-copilot overlay over the KVM surface.
    const copilotView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-copilot.js"),
        },
    });
    copilotView.setBackgroundColor("#00000000");
    copilotView.setVisible(false);
    const copilotBounds = { x: 80, y: TITLEBAR_HEIGHT + 24, width: 340, height: 220 };
    let copilotVisible = false;
    let copilotPlaced = false; // becomes true after first auto-placement; then we keep the user's position
    let copilotHideTimer: NodeJS.Timeout | null = null;

    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));

    // Opt-in: load the KVM view through our own proxy instead of the Pi directly,
    // so the desktop shares the web client's rendering path. Off by default; needs
    // a restart to change. `viewOrigin()` is a live function so a runtime origin
    // change still applies in the default (non-proxy) mode.
    const PROXY_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
    const desktopProxy = settings.get().desktopUseProxy;
    const viewOrigin = () => (desktopProxy ? PROXY_ORIGIN : origin);
    if (desktopProxy) {
        // Mark this Electron session as the desktop shell so the proxy suppresses
        // the injected floating panel (the desktop has its own native sidebar).
        void session.defaultSession.cookies
            .set({ url: PROXY_ORIGIN, name: "agent_shell", value: "desktop", expirationDate: Date.now() / 1000 + 31536000 })
            .catch(() => {});
    }

    let canCloseByButton = false;
    let sidebarOpen = false;
    let sidebarWidth = settings.get().sidebarWidth;
    let agentActing = false;

    win.contentView.addChildView(overlayView);
    win.contentView.addChildView(mainView);
    // Control overlay above the KVM; sidebar above that; copilot floats on top.
    win.contentView.addChildView(controlOverlayView);
    win.contentView.addChildView(sidebarView);
    win.contentView.addChildView(copilotView);
    copilotView.webContents.loadFile(resolve(__dirname, "views", "copilot.html"));

    const clampCopilot = () => {
        const [w, h] = win.getContentSize();
        copilotBounds.width = Math.min(copilotBounds.width, w!);
        copilotBounds.height = Math.min(copilotBounds.height, Math.max(80, h! - TITLEBAR_HEIGHT));
        copilotBounds.x = Math.max(0, Math.min(copilotBounds.x, w! - copilotBounds.width));
        copilotBounds.y = Math.max(TITLEBAR_HEIGHT, Math.min(copilotBounds.y, h! - copilotBounds.height));
        copilotView.setBounds(copilotBounds);
    };
    const showCopilot = () => {
        // Only auto-place the first time; afterwards keep wherever the user dragged it.
        if (!copilotPlaced) {
            const [w] = win.getContentSize();
            const sbW = sidebarOpen ? sidebarWidth : 0;
            copilotBounds.x = Math.max(12, w! - sbW - copilotBounds.width - 20); // top-right, clear of the sidebar
            copilotBounds.y = TITLEBAR_HEIGHT + 24;
            copilotPlaced = true;
        }
        clampCopilot();
        copilotView.setVisible(true);
        copilotVisible = true;
    };
    const hideCopilot = () => {
        copilotView.setVisible(false);
        copilotVisible = false;
    };

    ipcMain.on("copilot:drag", (_, { dx, dy }: { dx: number; dy: number }) => {
        copilotBounds.x += dx;
        copilotBounds.y += dy;
        clampCopilot();
    });
    ipcMain.on("copilot:resize", (_, { height }: { height: number }) => {
        copilotBounds.height = Math.max(60, Math.min(640, Math.round(height)));
        clampCopilot();
    });
    ipcMain.on("copilot:close", () => {
        hideCopilot();
    });

    const setAgentActing = (acting: boolean) => {
        if (acting === agentActing) return;
        agentActing = acting;
        controlOverlayView.setVisible(acting);
        if (acting) layout();
    };

    const layout = () => {
        const [w, h] = win.getContentSize();
        console.log(`Layout: ${w}x${h}`);

        const sbW = sidebarOpen ? sidebarWidth : 0;

        mainView.setBounds({
            x: 0,
            y: TITLEBAR_HEIGHT,
            width: w! - sbW,
            height: h! - TITLEBAR_HEIGHT,
        });

        // Docked right; slides off the right edge when closed.
        sidebarView.setBounds({
            x: w! - sbW,
            y: TITLEBAR_HEIGHT,
            width: sidebarWidth,
            height: h! - TITLEBAR_HEIGHT,
        });

        overlayView.setBounds({
            x: 0,
            y: 0,
            width: w!,
            height: h!,
        });

        // Control overlay tracks the KVM area exactly.
        controlOverlayView.setBounds({
            x: 0,
            y: TITLEBAR_HEIGHT,
            width: w! - sbW,
            height: h! - TITLEBAR_HEIGHT,
        });

        // Keep the floating copilot within the (possibly resized) window.
        if (copilotVisible) clampCopilot();

        mainView.webContents.send("window:resize", mainView.getBounds());
    };

    sidebarView.webContents.loadFile(resolve(__dirname, "views", "sidebar.html"));
    controlOverlayView.webContents.loadFile(resolve(__dirname, "views", "acting.html"));

    // Right-click editing menus everywhere; the sidebar also offers "Copy conversation".
    attachContextMenu(mainView.webContents);
    attachContextMenu(overlayView.webContents);
    attachContextMenu(sidebarView.webContents, { conversation: true });

    ipcMain.on("sidebar:toggle", () => {
        sidebarOpen = !sidebarOpen;
        console.log("Sidebar toggle:", sidebarOpen);
        // Grow the window to fit the sidebar beside the KVM, rather than
        // shrinking the KVM view.
        const [w, h] = win.getContentSize();
        const delta = sidebarOpen ? sidebarWidth : -sidebarWidth;
        win.setContentSize(Math.max(300, w! + delta), h!);
        layout();
    });

    // Drag-to-resize the sidebar: the renderer sends the desired width.
    ipcMain.on("sidebar:resize", (_, width: number) => {
        const next = Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)));
        if (!sidebarOpen || next === sidebarWidth) return;
        const [w, h] = win.getContentSize();
        win.setContentSize(w! + (next - sidebarWidth), h!);
        sidebarWidth = next;
        settings.patch({ sidebarWidth: next });
        layout();
    });

    // Unified input tracker (agent + the user's own keystrokes on the KVM page).
    const inputTracker = new InputTracker();
    ipcMain.on("kvm:user-input", (_, data) => {
        if (!data) return;
        if (data.type === "key" && typeof data.key === "string") inputTracker.applyKey("user", data.key);
        else if (data.type === "mouse") inputTracker.mouse("user", `button ${data.button ?? 0}`);
    });

    // Start the agentic backend (control core + agent + MCP/chat server).
    const agentBackend = startAgentBackend(origin, settings, inputTracker);

    // Agent screenshots come from the already-rendered live view (capturePage),
    // NOT the PiKVM snapshot endpoint — so they put no load on the Pi and never
    // stall the live stream the user is watching.
    agentBackend.control.captureScreen = async () => {
        try {
            const img = await mainView.webContents.capturePage();
            const sz = img.getSize();
            if (!sz.width || !sz.height) return null;
            return { data: img.toJPEG(80), width: sz.width, height: sz.height };
        } catch {
            return null;
        }
    };

    // Cheap 16x16 grayscale fingerprint for the ambient monitor's change detector
    // (no decode lib, no LLM — just a perceptual diff between consecutive frames).
    agentBackend.control.captureFingerprint = async () => {
        try {
            const img = await mainView.webContents.capturePage();
            if (!img.getSize().width) return null;
            const small = img.resize({ width: 16, height: 16, quality: "good" });
            const bmp = small.toBitmap(); // BGRA, 16*16*4 bytes
            const fp = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                const o = i * 4;
                fp[i] = ((bmp[o]! + bmp[o + 1]! + bmp[o + 2]!) / 3) | 0;
            }
            return fp;
        } catch {
            return null;
        }
    };

    // Meeting transcription: feed renderer audio blobs into the local whisper
    // pipeline, and start/stop capture as the ambient monitor enters/leaves a meeting.
    ipcMain.on("kvm:audio-chunk", (_, b64: string) => {
        try {
            agentBackend.transcriber.pushAudio(Buffer.from(b64, "base64"));
        } catch {
            /* ignore malformed chunk */
        }
    });
    // The renderer reports which audio sources it tapped (mic / remote) so the
    // transcriber's status can explain a stuck "Listening…".
    ipcMain.on("kvm:audio-status", (_, s: { mic?: boolean; remote?: boolean; error?: string | null }) => {
        agentBackend.transcriber.setCaptureStatus(s ?? {});
    });
    // Manual transcription toggle (server endpoint) → drive renderer capture.
    agentBackend.transcriber.on("capture", (on: boolean) => {
        mainView.webContents.send(on ? "kvm:transcribe-start" : "kvm:transcribe-stop");
    });
    agentBackend.ambient.on("event", (e: { kind: string }) => {
        if (e.kind === "meeting-start") {
            if (copilotHideTimer) {
                clearTimeout(copilotHideTimer);
                copilotHideTimer = null;
            }
            // Fresh transcript per meeting — don't let the prior meeting bleed in.
            agentBackend.transcriber.clear();
            if (agentBackend.settings.get().ambient.transcribe) {
                agentBackend.transcriber.start();
                mainView.webContents.send("kvm:transcribe-start");
            }
            // Pop the floating copilot over the KVM.
            if (agentBackend.settings.get().ambient.meetingAssist) showCopilot();
        } else if (e.kind === "meeting-end") {
            agentBackend.transcriber.stop();
            mainView.webContents.send("kvm:transcribe-stop");
            // Keep the copilot up briefly so the end-of-meeting recap lands.
            if (copilotHideTimer) clearTimeout(copilotHideTimer);
            copilotHideTimer = setTimeout(() => {
                hideCopilot();
                copilotHideTimer = null;
            }, 30000);
        }
    });

    // Surface the recognised app + sensitivity onto the overlay so the user sees
    // where the agent thinks it is (and when it's in a sensitive area).
    agentBackend.runner.onContext = (ctx) => {
        controlOverlayView.webContents.send("overlay:context", ctx);
    };

    // Mirror the agent's "is acting" state onto the control overlay.
    agentBackend.runner.subscribe((event) => {
        if (event.type === "tool_execution_start") {
            setAgentActing(true);
            const args = (event as any).args ?? {};
            controlOverlayView.webContents.send("overlay:acting", {
                action: humanAction(event.toolName, args),
            });
            // Drive the on-screen AI cursor for pointer actions.
            if (
                (event.toolName === "move_mouse" || event.toolName === "click" || event.toolName === "double_click") &&
                typeof args.x === "number" &&
                typeof args.y === "number"
            ) {
                const dims = agentBackend.control.getDimensions();
                controlOverlayView.webContents.send("overlay:cursor", {
                    x: args.x,
                    y: args.y,
                    w: dims.width,
                    h: dims.height,
                    kind: event.toolName === "move_mouse" ? "move" : "click",
                });
            }
            // Show what the agent is READING: a labelled scan box for OCR (the key
            // ask) and for cropped/zoom screenshots. Routine full-frame screenshots
            // are skipped (the pulsing scrim already signals "looking").
            const hasRegion = args.region && typeof args.region.x === "number" && typeof args.region.width === "number";
            const verifyRegion = args.verify_region && typeof args.verify_region.x === "number";
            if (event.toolName === "ocr" || (event.toolName === "screenshot" && hasRegion) || (event.toolName === "type_text" && verifyRegion)) {
                const dims = agentBackend.control.getDimensions();
                const r =
                    event.toolName === "type_text"
                        ? args.verify_region
                        : hasRegion
                          ? args.region
                          : { x: 0, y: 0, width: dims.width, height: dims.height };
                const label =
                    event.toolName === "ocr"
                        ? hasRegion
                            ? "Reading text"
                            : "Reading screen"
                        : event.toolName === "type_text"
                          ? "Checking typing"
                          : "Zoom in";
                controlOverlayView.webContents.send("overlay:region", {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                    w: dims.width,
                    h: dims.height,
                    label,
                    // Typing + read-back takes longer than a one-shot OCR; hold longer.
                    hold: event.toolName === "type_text" ? 3500 : 1500,
                });
            }
        } else if (event.type === "agent_end") {
            setAgentActing(false);
            // Notify on completion if the user isn't looking at the window.
            if (!win.isFocused() && Notification.isSupported()) {
                new Notification({ title: "Agent finished", body: "The task is complete." }).show();
            }
        }
    });

    ipcMain.on("agent:stop", () => {
        console.log("Emergency stop from overlay");
        agentBackend.runner.stop();
        setAgentActing(false);
    });

    ipcMain.on("agent:pause", () => {
        console.log("Pause — handing control to user");
        agentBackend.runner.pauseForUser();
        setAgentActing(false);
    });

    ipcMain.on("open-external", (_, url: string) => {
        if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
    });

    win.on("resize", layout);
    layout();

    const wc = mainView.webContents;

    ipcMain.handle("pikvm:set-origin", async (_, newOrigin: string) => {
        if (!newOrigin.startsWith("http")) return false;

        config.origin = newOrigin.replace(/\/$/, "");
        saveConfig(config);
        origin = config.origin;

        console.log("New PiKVM origin:", origin);
        wc.loadURL(viewOrigin());
        return true;
    });

    ipcMain.handle("pikvm:connected-to-origin", () => {
        return wc.getURL().startsWith(viewOrigin());
    });
    ipcMain.handle("pikvm:get-origin", () => origin);

    const connect = () => {
        console.log("Connecting to KVM view at:", viewOrigin());
        const parsed = new URL(viewOrigin());
        parsed.username = "";
        parsed.password = "";
        parsed.pathname = "/kvm";

        mainView.webContents.loadURL(parsed.toString());
    };

    ipcMain.on("pikvm:connect", () => {
        connect();
    });

    ipcMain.handle("pikvm:autofill-credentials", () => {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.username && parsedOrigin.password) {
            console.log("Autofill credentials found in origin URL");
            return {
                username: decodeURIComponent(parsedOrigin.username),
                password: decodeURIComponent(parsedOrigin.password),
            };
        }
        return null;
    });

    wc.setWindowOpenHandler(({ url }) => {
        console.log("Window open request:", url);

        const parsedOrigin = new URL(viewOrigin());
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("Opening externally");
            shell.openExternal(url);
            return { action: "deny" };
        }

        console.log("Allowed internally");
        return { action: "allow" };
    });

    wc.on("before-input-event", (_, input) => {
        if ((input.control || input.meta) && input.key.toLowerCase() === "w") {
            console.log("Blocked Ctrl/Cmd+W");
            return false;
        }
    });

    win.on("close", (e) => {
        const isOnKVMPage = wc.getURL().startsWith(viewOrigin() + "/kvm");
        if (isOnKVMPage && !canCloseByButton) e.preventDefault();
    });

    wc.on("will-navigate", (e, url) => {
        console.log("Will navigate:", url);

        const parsedOrigin = new URL(viewOrigin());
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("External navigation blocked");
            e.preventDefault();
            shell.openExternal(url);
        }
    });

    function sendWindowState() {
        let onKVM = false;
        try {
            onKVM = new URL(wc.getURL()).pathname.startsWith("/kvm");
        } catch {
            /* not a real URL yet */
        }

        const state = {
            isMaximized: win.isMaximized(),
            canMaximize: canMaximize,
            canMinimize: win.isMinimizable(),
            title: wc.getTitle(),
            isFocused: win.isVisible() && isFocused && isCursorInWinBounds(),
            theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
            // The agent can only see/drive the screen on the KVM page.
            onKVM,
        };

        overlayView.webContents.send("window:state", state);
        mainView.webContents.send("window:state", state);
        sidebarView.webContents.send("window:state", state);
        // Let the ambient monitor know whether the screen is actually visible.
        agentBackend.setOnKVM(onKVM);
    }

    let canMaximize = win.isMaximizable();

    wc.on("did-navigate", async (_, url) => {
        console.log("Navigated:", url);

        const isKVMPage = new URL(url).pathname.startsWith("/kvm");
        const isTerminalPage = new URL(url).pathname.startsWith(
            "/extras/webterm"
        );
        console.log("KVM page:", isKVMPage);

        await wc.executeJavaScript(`window.kvm?.init?.()`);
        // Match the input-forwarding guard to the current focus state on load.
        mainView.webContents.send("kvm:input-enabled", win.isFocused());
        sendWindowState();

        if (isKVMPage || isTerminalPage) {
            await wc.executeJavaScript(`window.kvm?.enter?.()`);
            canMaximize = true;
            win.setMaximizable(true);
            win.setClosable(false);

            console.log("Entering KVM mode");
            win.setSize(kvmSize.width, kvmSize.height);
            win.setResizable(true);

            console.log("KVM mode set");
        } else {
            console.log("Normal mode");

            lastStreamData = null;

            // Left the KVM screen — collapse the agent sidebar so it isn't
            // stranded open without its (now-hidden) toggle button.
            if (sidebarOpen) {
                sidebarOpen = false;
                controlOverlayView.setVisible(false);
            }

            if (
                url ===
                "file://" + resolve(__dirname, "views", "settings.html")
            ) {
                win.setSize(settingsSize.width, settingsSize.height);
                console.log(win.getSize());
            } else {
                win.setSize(normalSize.width, normalSize.height);
            }
            win.setResizable(false);

            canMaximize = false;
            win.setMaximizable(false);
            win.unmaximize();
            win.setClosable(true);
        }

        console.log("Injecting CSS");

        const cssData = [
            readFileSync(resolve(staticPath, "index.css"), "utf-8"),
            isKVMPage && readFileSync(resolve(staticPath, "kvm.css"), "utf-8"),
        ]
            .filter(Boolean)
            .join("\n");

        wc.send("kvm-css", cssData);

        sendWindowState();
    });

    ipcMain.on("window:minimise", () => {
        console.log("Minimise");
        win.minimize();
    });

    ipcMain.on("window:maximise", () => {
        console.log("Toggle maximise");
        win.isMaximized() ? win.unmaximize() : win.maximize();
    });

    ipcMain.on("window:close", () => {
        console.log("Close (UI)");
        canCloseByButton = true;
        win.close();
    });

    ipcMain.on("window:restore", () => {
        console.log("Restore");
        win.unmaximize();
    });

    // Snap the window to the KVM's native resolution (plus titlebar + sidebar).
    ipcMain.on("window:fit-native", () => {
        if (!lastStreamData?.width || !lastStreamData?.height) return;
        if (win.isMaximized()) win.unmaximize();
        win.setContentSize(
            lastStreamData.width + (sidebarOpen ? sidebarWidth : 0),
            lastStreamData.height + TITLEBAR_HEIGHT
        );
        setTimeout(() => layout(), 100);
    });

    ipcMain.on("navigate-back", () => {
        console.log("Navigate back");
        if (wc.navigationHistory.canGoBack()) {
            console.log("Going back in navigation history");
            wc.navigationHistory.goBack();
        } else {
            console.log("No navigation history to go back to");
        }
    });

    let lastStreamData: any = null;

    ipcMain.on("kvm-stream-data", (_, data) => {
        console.log("KVM stream data:", data);

        if (
            lastStreamData &&
            lastStreamData.width === data.width &&
            lastStreamData.height === data.height &&
            lastStreamData.isTransmittingAudio === data.isTransmittingAudio &&
            lastStreamData.isTransmittingMicrophone ===
                data.isTransmittingMicrophone
        ) {
            return;
        }

        lastStreamData = data;

        try {
            if (
                data.width &&
                data.height &&
                typeof data.width === "number" &&
                typeof data.height === "number"
            ) {
                console.log(
                    `Resizing window to stream dimensions: ${data.width}x${data.height}`
                );

                win.setContentSize(
                    data.width + (sidebarOpen ? sidebarWidth : 0),
                    data.height + TITLEBAR_HEIGHT
                );
                setTimeout(() => {
                    layout();
                }, 100);
            }

            // Drive the presence / do-not-disturb gate off the PiKVM's own
            // mic/audio transmission state.
            agentBackend.presence.setMediaState({
                audio: !!data.isTransmittingAudio,
                mic: !!data.isTransmittingMicrophone,
            });
            // Native resolution for OCR coordinate scaling.
            if (data.width && data.height) agentBackend.control.setNativeDims(data.width, data.height);

            mainView.webContents.send("kvm:media-transmission", {
                isTransmittingAudio: data.isTransmittingAudio,
                isTransmittingMicrophone: data.isTransmittingMicrophone,
            });
        } catch (e) {
            console.error("Failed to parse stream dimensions:", e);
        }
    });

    let isFocused = win.isFocused();

    function isCursorInWinBounds() {
        const cursorPos = screen.getCursorScreenPoint();
        const winBounds = win.getBounds();
        return (
            cursorPos.x >= winBounds.x &&
            cursorPos.x <= winBounds.x + winBounds.width &&
            cursorPos.y >= winBounds.y &&
            cursorPos.y <= winBounds.y + winBounds.height
        );
    }

    win.on("focus", () => {
        isFocused = true;
        // Re-enable forwarding input to the remote now that we're focused.
        mainView.webContents.send("kvm:input-enabled", true);
        sendWindowState();
    });
    win.on("blur", () => {
        isFocused = false;
        // Stop any mouse/keyboard from reaching the KVM while we're not focused.
        mainView.webContents.send("kvm:input-enabled", false);
        sendWindowState();
    });
    win.on("maximize", sendWindowState);
    win.on("unmaximize", sendWindowState);
    win.on("restore", sendWindowState);
    win.on("resize", sendWindowState);

    mainView.webContents.addListener("page-title-updated", sendWindowState);
    mainView.webContents.addListener("did-finish-load", sendWindowState);
    mainView.webContents.addListener("did-navigate", sendWindowState);
    mainView.webContents.addListener("did-navigate-in-page", sendWindowState);
    mainView.webContents.addListener("did-stop-loading", sendWindowState);
    mainView.webContents.addListener("did-frame-finish-load", sendWindowState);
    mainView.webContents.addListener("dom-ready", sendWindowState);
    mainView.addListener("bounds-changed", sendWindowState);
    mainView.webContents.addListener("focus", sendWindowState);
    mainView.webContents.addListener("blur", sendWindowState);
    mainView.webContents.addListener("paint", sendWindowState);
    mainView.webContents.addListener("frame-created", sendWindowState);
    mainView.webContents.addListener("zoom-changed", () => {
        mainView.webContents.setVisualZoomLevelLimits(1, 1);
        mainView.webContents.setZoomLevel(1);
    });

    nativeTheme.on("updated", () => {
        sendWindowState();
    });

    mainView.webContents.on("will-prevent-unload", (e) => {
        console.log("Unload prevented");
        e.preventDefault();
    });

    console.log("Loading overlay UI");
    overlayView.webContents.loadFile(resolve(__dirname, "views", "ui.html"));
    overlayView.webContents.setIgnoreMenuShortcuts(true);
    overlayView.webContents.setVisualZoomLevelLimits(1, 1);

    sendWindowState();

    mainView.webContents.loadFile(resolve(__dirname, "views", "settings.html"));

    mainView.webContents.addListener(
        "did-fail-load",
        (
            e,
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
            frameProcessId,
            frameRoutingId
        ) => {
            console.log("Main view failed to load");
            mainView.webContents.loadFile(
                resolve(__dirname, "views", "settings.html")
            );
            console.error(`Failed to load URL: ${validatedURL}`);
            console.error(e);
            dialog.showErrorBox(
                "Error",
                "Failed to load PiKVM interface.\n\nError code: " +
                    errorCode +
                    "\nDescription: " +
                    errorDescription +
                    "\nURL: " +
                    validatedURL +
                    "\n\nPlease check the PiKVM URL in settings."
            );
        }
    );

    let comboStart: number | null = null;
    let comboActive = false;

    mainView.webContents.on("before-input-event", (_, input) => {
        const fullCombo = input.control && input.shift && input.alt;

        // combo just became active
        if (input.type === "keyDown" && fullCombo && !comboActive) {
            comboActive = true;
            comboStart = Date.now();
        }

        // combo just broke
        if (input.type === "keyUp" && comboActive && !fullCombo) {
            const duration = Date.now() - (comboStart ?? 0);
            comboActive = false;
            comboStart = null;

            if (duration <= 300) {
                setTimeout(() => {
                    mainView.webContents.send("kvm:release-mouse");
                }, 100);
            }
        }
    });

    const allowedPermissions = new Set([
        "media",
        "clipboard-read",
        "clipboard-sanitized-write",
        "clipboard-write",
    ]);
    session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback) => {
            if (allowedPermissions.has(permission)) {
                callback(true);
            } else {
                console.log(`Blocked permission request: ${permission}`);
                callback(false);
            }
        }
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
        allowedPermissions.has(permission)
    );

    // Reliable clipboard for the sidebar (navigator.clipboard can be flaky in views).
    ipcMain.on("clipboard:write", (_, contentText: string) => {
        if (typeof contentText === "string") clipboard.writeText(contentText);
    });

    if (
        process.env.NODE_ENV === "development" ||
        process.env.DEVTOOLS === "1"
    ) {
        overlayView.webContents.openDevTools({ mode: "detach" });
        mainView.webContents.openDevTools({ mode: "detach" });
    }

    mainView.webContents.focus();
}

app.whenReady().then(() => {
    console.log("Electron ready");
    app.commandLine.appendSwitch("ignore-certificate-errors");

    createWindow();
});
