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
    Menu,
} from "electron";
import {
    readFileSync,
    existsSync,
    writeFileSync,
    statSync,
    realpathSync,
    watch,
} from "fs";
import { resolve, isAbsolute, extname } from "path";
import { PiKvmControl } from "./pikvm-control";
import { electronImageOps } from "./image-ops-electron";
import { startControlServer } from "./server";
import { SettingsStore } from "./settings";
import { TerminalSessions } from "./terminal-server";
import { ManagedService } from "./service-manager";
import { HarnessManager } from "./harness-manager";
import { activeManagedClientRuntimePath } from "./harness-runtime";
import { HarnessViewLifecycle } from "./harness-view-lifecycle";
import { WORKSPACE_PREFIX } from "./workspace-assets";
import { requestAttention } from "./taskbar-attention";

const staticPath = resolve(__dirname, "static");
const appIconPath = resolve(__dirname, "assets/icon.png");

// Friendly product name — drives the dock tooltip / WM_CLASS and the about
// panel. Without this, Linux falls back to the package name
// ("pikvm-desktop-agentic") and a generic icon.
app.setName("PiKVM Desktop");

// CRITICAL — must be set BEFORE app is ready. When the agent acts, the transparent
// "agent in control" overlay sits over the console, so Chromium treats the console
// renderer as OCCLUDED and freezes its background timers — including the sidebar's
// /api/state poll. That's why an approval prompt never appeared until you pressed Stop
// (which hides the overlay and wakes the renderer, firing the poll). webPreferences
// backgroundThrottling:false does NOT cover occlusion on Linux/X11; these switches do.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

/** Port for the local control server (MCP + sidebar chat bridge). Overridable via
 *  PIKVM_CONTROL_PORT so a dev build can run alongside an installed instance. */
const CONTROL_PORT = Number(process.env.PIKVM_CONTROL_PORT) || 25650;

// The unified web console (/_agent/console) is the PRIMARY desktop UI: the main
// window loads it and the console draws its own titlebar/chrome (via the console
// preload's `window.desktopConsole`). The legacy native KVM-page + sidebar
// composition is kept behind PIKVM_NATIVE_UI=1.
const useConsole = process.env.PIKVM_NATIVE_UI !== "1";
// Map a console RENDERER's webContents id → its window. The main window hosts the
// console in a child WebContentsView, so BrowserWindow.fromWebContents(sender) can
// return null; this resolves the window reliably for the console-scoped IPC.
const consoleWcToWin = new Map<number, Electron.BrowserWindow>();
// Window-chrome per platform: macOS keeps its native traffic lights (titleBarStyle
// "hidden", positioned to sit inside our 38px titlebar); Linux + Windows are fully
// frameless so the console draws its own controls (GTK-style on Linux).
const consoleFrameOpts: Electron.BrowserWindowConstructorOptions =
    process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 13, y: 10 } } : { frame: false };

/** The isolated session the conversation runs in.
 *
 *  Everything that shows the harness uses this partition — the embedded panel and
 *  the detached window both — and main rewrites the Authorization header on it so
 *  the real operator credential never reaches renderer JavaScript. Named once
 *  because a view that opened on a DIFFERENT partition would silently lose that
 *  rewrite, and the only symptom would be an auth prompt nobody could explain. */
const HARNESS_PARTITION = "pikvm-harness";

/** Where the conversation is served from, for BOTH the embedded frame and the
 *  detached window. Our own origin, so its API comes back through the proxy that
 *  injects the operator credential rather than through a session header rewrite,
 *  and there is one path to keep working instead of two. */
function workspaceUrl(): string {
    return `http://127.0.0.1:${CONTROL_PORT}${WORKSPACE_PREFIX}/`;
}

/** Where the pikvm-agent executable might be, best candidate first.
 *
 *  agent/ is part of this repo now, so its venv leads. The standalone checkout
 *  stays on the list below it so an existing working setup keeps running while
 *  the move settles — this is a search, not a migration, and nothing has to be
 *  moved on disk for the app to start.
 *
 *  The daemon and the harness are the SAME installation, and this list used to
 *  be written out twice, once in each resolver. Two copies of a preference order
 *  is how the two end up launching different builds the day one of them gains a
 *  candidate the other does not. */
function agentExecutables(...preferred: (string | undefined)[]): string[] {
    const inRepo = resolve(__dirname, "..", "agent", ".venv", "bin", "pikvm-agent");
    const standalone = resolve(app.getPath("home"), "dev/pikvm-agent/.venv/bin/pikvm-agent");
    return [...preferred, inRepo, standalone].filter(Boolean) as string[];
}

/** Resolve the command that launches the pikvm-agent daemon. Falls back to the
 *  bare name so a PATH install still works. */
function resolveDaemonCommand(configured?: string): { command: string; args: string[] } {
    for (const c of agentExecutables(configured, process.env.PIKVM_AGENT_DAEMON_CMD)) {
        if (existsSync(c)) return { command: c, args: ["daemon"] };
    }
    return { command: "pikvm-agent", args: ["daemon"] }; // rely on PATH
}

/** Resolve the same pikvm-agent installation for the first-party harness. */
function resolveHarnessCommand(configured?: string): string {
    for (const c of agentExecutables(configured, process.env.PIKVM_HARNESS_CMD, process.env.PIKVM_AGENT_DAEMON_CMD)) {
        if (existsSync(c)) return c;
    }
    return "pikvm-agent";
}

function resolvedHarnessOrigin(): string {
    return (process.env.PIKVM_HARNESS_ORIGIN || "http://127.0.0.1:47616").replace(
        /\/$/,
        "",
    );
}

/** Text into an HTML document. Used for the harness view's failure page, whose
 *  only variable parts are a local origin and an Electron error description. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Start the PiKVM backend, first-party harness, and local console proxy. */
function startProxyAndHarness(
    origin: string,
    settings: SettingsStore,
    harnessCommand: string,
) {
    const control = new PiKvmControl(
        {
            origin,
            // Reuse the logged-in PiKVM web session so proxied requests are authorized
            // even when credentials aren't in the URL.
            getCookie: async () => {
                try {
                    const cookies = await session.defaultSession.cookies.get({ name: "auth_token" });
                    return cookies[0]?.value;
                } catch {
                    return undefined;
                }
            },
        },
        electronImageOps,
    );

    // Apply persisted preferences that the proxy/control core honours.
    const s = settings.get();
    control.setLayout(s.keyboardLayout, { source: "auto" }); // let the Pi's hid_keymaps refine this saved default

    // Bind to the LAN only when the user opts in (so a phone/browser can reach
    // the proxy); default to loopback.
    // PIKVM_BIND_HOST overrides the persisted setting (e.g. 0.0.0.0 to test from a
    // phone with a dev build, without flipping the setting the installed app shares).
    const bindHost = process.env.PIKVM_BIND_HOST || settings.get().bindHost || "127.0.0.1";

    // Keep the optional browser/mobile shell service available for compatibility.
    // The desktop app does not create or render a terminal WebContentsView.
    const vaultPath = (): string => {
        const path = settings.get().atlas?.vaultPath;
        return path && path.trim() ? path : app.getPath("home");
    };
    const resolvePath = (path: string): string => {
        if (path.startsWith("~/")) return resolve(app.getPath("home"), path.slice(2));
        return isAbsolute(path) ? path : resolve(vaultPath(), path);
    };
    const imageMime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    };
    const terminalSessions = new TerminalSessions({
        vaultPath,
        port: CONTROL_PORT,
        prepareAgent: () => {},
        resolveImage: (path) => {
            try {
                const absolute = resolvePath(path);
                const mime = imageMime[extname(absolute).toLowerCase()];
                if (!mime || !existsSync(absolute)) return null;
                if (statSync(absolute).size > 12 * 1024 * 1024) return null;
                return `data:${mime};base64,${readFileSync(absolute).toString("base64")}`;
            } catch {
                return null;
            }
        },
        openPath: (path) => {
            const absolute = resolvePath(path);
            if (existsSync(absolute)) void shell.openPath(absolute);
        },
        openExternal: (url) => {
            if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        },
    });

    // The desktop owns both local services and creates two non-interchangeable
    // daemon capabilities. Guarded-direct clients receive only the action
    // capability; the harness-only approval capability stays in child env.
    const daemonOrigin = (process.env.PIKVM_AGENT_DAEMON || settings.get().daemonUrl || "http://127.0.0.1:47615").replace(/\/$/, "");
    const harnessOrigin = resolvedHarnessOrigin();
    const configuredHarnessPath =
        process.env.PIKVM_HARNESS_CONFIG || settings.get().harnessConfig;
    const harnessConfig = configuredHarnessPath
        ? isAbsolute(configuredHarnessPath)
            ? configuredHarnessPath
            : resolve(settings.dir(), configuredHarnessPath)
        : resolve(settings.dir(), "harness.yaml");
    const harness = new HarnessManager({
        origin: harnessOrigin,
        daemonOrigin,
        command: harnessCommand,
        configPath: harnessConfig,
        runtimePath:
            process.env.PIKVM_HARNESS_RUNTIME ||
            resolve(settings.dir(), "harness-runtime.json"),
        managedClientRuntimePath: activeManagedClientRuntimePath(),
        cwd: settings.dir(),
        log: (line) => console.log(line),
    });

    startControlServer(
        {
            control,
            settings,
            terminalSessions,
            daemonOrigin,
            daemonToken: harness.daemonActionToken,
            /* So the conversation can be served from this origin and still reach
             * its own API. The operator capability is handed to the PROXY, never
             * to a renderer — same contract as the daemon token beside it. */
            harnessOrigin,
            harnessToken: harness.accessToken,
        },
        CONTROL_PORT,
        bindHost,
    );
    console.log(`PiKVM backend listening on http://${bindHost}:${CONTROL_PORT} (UI proxy + /_agent/*; daemon ${daemonOrigin})`);

    const { command, args } = resolveDaemonCommand(settings.get().daemonCmd);
    const daemon = new ManagedService({
        name: "daemon",
        origin: daemonOrigin,
        healthPath: "/healthz",
        command,
        args,
        env: {
            PIKVM_AGENT_DAEMON_TOKEN: harness.daemonActionToken,
            PIKVM_AGENT_HARNESS_TOKEN: harness.daemonHarnessToken,
        },
        adoptExisting: false,
        log: (line) => console.log(line),
    });
    const harnessReady = daemon.start().then(async (outcome) => {
        if (outcome === "conflict") {
            throw new Error(
                `another credential-bound daemon already owns ${daemonOrigin}`,
            );
        }
        if (!(await daemon.waitUntilHealthy())) {
            daemon.stop();
            throw new Error(
                `machine-control daemon did not become healthy at ${daemonOrigin}`,
            );
        }
        await harness.start();
    });
    void harnessReady.catch((error) =>
            console.error(`[harness] startup failed: ${String(error)}`),
        );
    return {
        control,
        settings,
        terminalSessions,
        daemon,
        harness,
        harnessReady,
    };
}

function resolveDevHarnessAssetDirectory(command: string): string | null {
    const configured = process.env.PIKVM_HARNESS_ASSET_DIR?.trim();
    if (configured) {
        const directory = isAbsolute(configured)
            ? configured
            : resolve(process.cwd(), configured);
        return existsSync(resolve(directory, "app.js")) ? directory : null;
    }
    if (!isAbsolute(command) || !existsSync(command)) return null;
    const executable = realpathSync(command);
    const directory = resolve(executable, "../../..", "pikvm_agent", "harness_ui");
    return existsSync(resolve(directory, "app.js")) ? directory : null;
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

/** Resolve a console-chromed window from an IPC sender (the main window in console
 *  mode and any "open in new window" console both carry the console preload). */
function consoleWinFrom(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Electron.BrowserWindow | null {
    const w = consoleWcToWin.get(event.sender.id);
    return w && !w.isDestroyed() ? w : null;
}

// ── Console window IPC (only the frameless console carries preload-console) ──
ipcMain.on("console:minimise", (e) => consoleWinFrom(e)?.minimize());
ipcMain.on("console:toggle-maximise", (e) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on("console:close", (e) => consoleWinFrom(e)?.close());
// The console's background sampler saw the remote screen change meaningfully
// while this window was NOT focused → pulse its taskbar/dock entry. The renderer
// only sends this when it is unfocused; requestAttention re-checks anyway, since
// focus can land between the sample and the message arriving here.
ipcMain.on("console:screen-activity", (e) => {
    const w = consoleWinFrom(e);
    if (w) requestAttention(w);
});
ipcMain.handle("console:is-maximised", (e) => {
    const w = consoleWinFrom(e);
    return !!w && w.isMaximized();
});

// Snap the window so the live-screen area renders the native resolution 1:1. The
// renderer passes the stream's native size plus the window chrome around the
// screen's CONTENT box — the agent column, the titlebar, the divider — measured
// as one leftover rather than listed part by part, which is how the 1px divider
// used to be missed. We add it back and set the window's CONTENT size (excludes
// the OS frame — and we're frameless anyway).
ipcMain.on("console:fit-native", (e, opts: { width?: number; height?: number; chromeWidth?: number; chromeHeight?: number }) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    const nw = Number(opts?.width);
    const nh = Number(opts?.height);
    if (!nw || !nh || nw < 1 || nh < 1) return;
    const chromeW = Math.max(0, Math.round(Number(opts?.chromeWidth) || 0));
    const chromeH = Math.max(0, Math.round(Number(opts?.chromeHeight) || 0));
    if (w.isMaximized()) w.unmaximize();
    // That chrome is FIXED-pixel (it doesn't scale), so we scale only the SCREEN
    // to fit the work area beside it, then add it back. This makes the screen
    // column land exactly on the stream aspect — no black bars.
    const area = screen.getDisplayMatching(w.getBounds()).workAreaSize;
    const availW = Math.max(320, area.width - chromeW);
    const availH = Math.max(240, area.height - chromeH);
    const scale = Math.min(1, availW / nw, availH / nh);
    const screenW = Math.round(nw * scale);
    const screenH = Math.round(nh * scale);
    w.setContentSize(screenW + chromeW, screenH + chromeH);
});

// Build + pop a NATIVE menu from the renderer's spec; send the chosen id back.
ipcMain.on("console:popup-menu", (e, payload: { items?: any[]; anchor?: { x: number; y: number } }) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const template: Electron.MenuItemConstructorOptions[] = items.map((it) => {
        if (it?.type === "separator") return { type: "separator" };
        return {
            label: String(it?.label ?? ""),
            type: it?.type === "checkbox" ? "checkbox" : "normal",
            checked: !!it?.checked,
            enabled: it?.enabled !== false,
            click: () => {
                // Send back to the SENDER renderer (the console view), not w.webContents
                // (empty for the main window which hosts the console in a child view).
                if (!e.sender.isDestroyed() && it?.id) e.sender.send("console:menu-command", String(it.id));
            },
        };
    });
    const menu = Menu.buildFromTemplate(template);
    const anchor = payload?.anchor;
    menu.popup(
        anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
            ? { window: w, x: Math.round(anchor.x), y: Math.round(anchor.y) }
            : { window: w }
    );
});

// ── Settings window ──────────────────────────────────────────────────────────
// The console's gear (and the native menu's "Settings") send console:open-settings.
// In the slim app there is no agent panel; open a small native Settings window with
// the only things a PiKVM client needs: connection URL, keyboard layout, jiggler.
const settingsFilePath = () => resolve(app.getPath("userData"), "agent-settings.json");
let settingsWin: Electron.BrowserWindow | null = null;
/** The console's current theme, so windows opened later match it.
 *
 *  The console owns the choice — it is a deliberate user setting kept in its own
 *  localStorage, not the OS preference — and it reports every change here. The
 *  Settings window is a separate BrowserWindow that cannot read that storage, so
 *  without remembering it here Settings opened black over a light console. */
let consoleTheme: "dark" | "light" = "dark";
const THEME_BG = { dark: "#0a0a0c", light: "#eef0f4" } as const;

function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.focus();
        return;
    }
    settingsWin = new BrowserWindow({
        width: 460,
        height: 360,
        resizable: false,
        minimizable: false,
        maximizable: false,
        center: true,
        darkTheme: consoleTheme === "dark",
        title: "PiKVM Desktop — Settings",
        backgroundColor: THEME_BG[consoleTheme],
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-settings.js"),
        },
    });
    settingsWin.removeMenu();
    void settingsWin.loadFile(resolve(__dirname, "views", "settings-console.html"));
    // Grow the window to whatever the page actually needs before showing it.
    // width/height above include the window chrome, and how much that is
    // differs per platform — this GTK frame takes 80px, which left the page
    // 280px for 352px of content, so Settings opened already scrolled with
    // "Save & restart" below the fold in a window that cannot be resized.
    // useContentSize is not the fix: it is ignored here. Measuring the rendered
    // page is, and it also covers a larger system font or a longer hint.
    settingsWin.webContents.once("did-finish-load", () => {
        if (!settingsWin || settingsWin.isDestroyed()) return;
        void settingsWin.webContents
            .executeJavaScript("document.documentElement.scrollHeight")
            .then((needed: unknown) => {
                if (!settingsWin || settingsWin.isDestroyed()) return;
                const size = settingsWin.getContentSize();
                const width = size[0] ?? 0;
                const height = size[1] ?? 0;
                const wanted = Math.min(Math.ceil(Number(needed) || 0), 900);
                if (wanted > height) settingsWin.setContentSize(width, wanted);
            })
            .catch(() => {
                /* the fixed size still shows most of the form; never block the window */
            });
    });
    settingsWin.once("ready-to-show", () => settingsWin?.show());
    settingsWin.on("closed", () => {
        settingsWin = null;
    });
}

ipcMain.on("console:open-settings", () => openSettingsWindow());

// Read current settings for the form (origin lives in the desktop config; layout +
// jiggler in the SettingsStore file).
ipcMain.on("settings:read", (e) => {
    let pikvmUrl = "";
    let config: any = {};
    try {
        config = loadConfig();
        pikvmUrl = config.origin || "";
    } catch {
        /* no config yet */
    }
    const s = new SettingsStore(settingsFilePath()).get();
    e.returnValue = {
        pikvmUrl,
        keyboardLayout: s.keyboardLayout,
        jiggler: s.jiggler,
        /* Whether the PiKVM URL below is actually used.
         *
         * This was `envLocked: !!process.env.PIKVM_CONSOLE_ORIGIN`, and the
         * settings window never read it — it appears there once, as a key in
         * the fallback object, and nowhere else. It was also measuring the
         * wrong thing twice over: nothing in this app reads an env var for
         * `origin` (the setting this form edits), and a remote console can be
         * configured through `config.consoleOrigin` with no env var in sight.
         *
         * What it should mean is the condition CONSOLE_ORIGIN already decides
         * on: when the console is served from somewhere else, this desktop is a
         * thin client and the remote server owns the connection, the capture
         * and the HID. The local origin is then read by nothing, so offering an
         * editable field for it invites a change that relaunches the app and
         * has no effect. Computed the same way as CONSOLE_ORIGIN so the two
         * cannot disagree. */
        originLocked: !!(config.consoleOrigin || process.env.PIKVM_CONSOLE_ORIGIN),
    };
});

// Persist settings and relaunch so the new origin/layout apply cleanly (mirrors the
// existing console:set-pikvm-origin behaviour).
ipcMain.on("settings:save", (_e, v: { pikvmUrl?: unknown; keyboardLayout?: unknown; jiggler?: unknown }) => {
    const layout = v?.keyboardLayout === "uk" ? "uk" : "us";
    // Only touch the jiggler when the form actually sent a boolean. `!!v?.jiggler`
    // turned it OFF for any save that omitted the field — a silent way to lose the
    // keep-awake without anyone choosing to.
    const patch: { keyboardLayout: "us" | "uk"; jiggler?: boolean } = { keyboardLayout: layout };
    if (typeof v?.jiggler === "boolean") patch.jiggler = v.jiggler;
    new SettingsStore(settingsFilePath()).patch(patch);
    const cfg = loadConfig();
    const url = typeof v?.pikvmUrl === "string" ? v.pikvmUrl.trim().replace(/\/$/, "") : "";
    if (url) cfg.origin = url;
    saveConfig(cfg);
    app.relaunch();
    app.exit(0);
});

ipcMain.on("settings:cancel", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
// Read synchronously at load, so the window paints in the right theme on its
// first frame rather than flashing the wrong one.
ipcMain.on("settings:theme", (e) => {
    e.returnValue = consoleTheme;
});

/** Standard editing context menu (cut/copy/paste/select all) for a view. */
function attachContextMenu(wc: Electron.WebContents) {
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
        if (!template.length) return;
        Menu.buildFromTemplate(template).popup();
    });
}

function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    let origin = config.origin;

    const kvmSize = { width: 1280, height: 720 };
    const normalSize = { width: 400, height: 350 };
    const settingsSize = { width: 400, height: 110 };
    const consoleSize = { width: 1400, height: 880 };
    const TITLEBAR_HEIGHT = 38;

    const win = new BrowserWindow({
        // The console is the full primary UI → open at a proper desktop size and let
        // it be resized; the legacy compact UI keeps its small start size.
        width: useConsole ? consoleSize.width : normalSize.width,
        height: useConsole ? consoleSize.height : normalSize.height,
        minWidth: useConsole ? 900 : 300,
        minHeight: useConsole ? 560 : 80,
        center: true,
        darkTheme: true,
        ...(useConsole ? consoleFrameOpts : { frame: false }),
        icon: appIconPath,
        title: "PiKVM Desktop",
        backgroundColor: "#0a0a0c",
        // Start hidden so the user never sees the white "flashbang" before the
        // console paints; we reveal it once the content has loaded (below).
        show: false,
    });

    const mainView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            // In console mode the main view IS the unified console, so it carries the
            // console preload (window.desktopConsole → its own titlebar, native menus,
            // fit-native). Otherwise the legacy KVM-page preload.
            preload: resolve(__dirname, useConsole ? "preload-console.js" : "preload.js"),
            // The console runs the live agent overlay SSE + transcription capture timers;
            // don't let Chromium throttle them when the window is unfocused.
            backgroundThrottling: false,
        },
    });
    // Dark view background so there is no white paint before the console CSS applies.
    mainView.setBackgroundColor("#0a0a0c");

    // Reveal the window only once the main content has loaded (or after a safety
    // timeout), so there is no flash of an empty/white window on launch.
    let shownOnce = false;
    let consoleLoadFails = 0; // consecutive remote-console load failures
    const revealWindow = () => {
        if (shownOnce || win.isDestroyed()) return;
        shownOnce = true;
        win.show();
    };
    mainView.webContents.on("did-finish-load", () => {
        consoleLoadFails = 0; // loaded OK — reset the remote-failure counter
        setTimeout(revealWindow, 60);
    });
    setTimeout(revealWindow, 4000); // fallback in case load never finishes

    const overlayView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-ui.js"),
        },
    });

    // The first-party chat harness is the desktop's sole workspace. Its isolated
    // session lets main inject the operator credential without ever exposing that
    // credential to page JavaScript.
    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));
    const harnessCommand = resolveHarnessCommand(settings.get().harnessCmd);
    const HARNESS_ORIGIN = resolvedHarnessOrigin();
    const HARNESS_URL = `${HARNESS_ORIGIN}/app/`;
    const harnessViewLifecycle = new HarnessViewLifecycle(HARNESS_URL);

    // Opt-in: load the KVM view through our own proxy instead of the Pi directly,
    // so the desktop shares the web client's rendering path. Off by default; needs
    // a restart to change. `viewOrigin()` is a live function so a runtime origin
    // change still applies in the default (non-proxy) mode.
    const PROXY_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
    const desktopProxy = settings.get().desktopUseProxy;
    // The console can be served from ANYWHERE — set it in Settings → Connection (or
    // the PIKVM_CONSOLE_ORIGIN env override) to point the desktop at a hosted
    // deployment. When it's not the local server, the desktop is a pure THIN CLIENT:
    // it loads the remote console and does NOT start a local backend (the remote
    // server owns the agent, capture, HID, proxy, etc.).
    const CONSOLE_ORIGIN = (config.consoleOrigin || process.env.PIKVM_CONSOLE_ORIGIN || PROXY_ORIGIN).replace(/\/$/, "");
    const remoteConsole = CONSOLE_ORIGIN !== PROXY_ORIGIN;
    const viewOrigin = () => (desktopProxy ? PROXY_ORIGIN : origin);
    const CONSOLE_URL = `${CONSOLE_ORIGIN}/_agent/console`;
    if (desktopProxy) {
        // Mark this Electron session as the desktop shell so the proxy suppresses
        // the injected floating panel (the desktop has its own native sidebar).
        void session.defaultSession.cookies
            .set({ url: PROXY_ORIGIN, name: "agent_shell", value: "desktop", expirationDate: Date.now() / 1000 + 31536000 })
            .catch(() => {});
    }

    let canCloseByButton = false;
    /* sidebarWidth outlived the sidebar: src/sidebar was removed when the agent
     * moved out of the app, and this is now just the remembered width the
     * detached conversation window opens at. There is no sidebarOpen any more —
     * nothing was ever placed in the space it reserved. */
    let sidebarWidth = settings.get().sidebarWidth;

    // In console mode the main window IS a console-chromed window: it carries the
    // console preload, so register it for the console-scoped IPC (window controls,
    // fit-native, native menus) and mirror its maximise state to the titlebar glyph.
    if (useConsole) {
        // The console renderer is mainView (a child view), so register ITS webContents
        // and send window-state to it (not win.webContents, which is empty).
        const consoleWcId = mainView.webContents.id;
        consoleWcToWin.set(consoleWcId, win);
        const mirrorMax = () => {
            if (!win.isDestroyed()) mainView.webContents.send("console:maximise-change", win.isMaximized());
        };
        win.on("maximize", mirrorMax);
        win.on("unmaximize", mirrorMax);
        win.on("closed", () => consoleWcToWin.delete(consoleWcId));
    }

    win.contentView.addChildView(overlayView);
    win.contentView.addChildView(mainView);

    const layout = () => {
        const [w, h] = win.getContentSize();
        console.log(`Layout: ${w}x${h}`);

        // The console draws its OWN titlebar, so the main view fills the whole window.
        const topY = useConsole ? 0 : TITLEBAR_HEIGHT;
        mainView.setBounds({
            x: 0,
            y: topY,
            width: w!,
            height: h! - topY,
        });

        overlayView.setBounds({
            x: 0,
            y: 0,
            width: w!,
            height: h!,
        });

        mainView.webContents.send("window:resize", mainView.getBounds());
    };

    const openUrlExternally = (url: string): boolean => {
        if (!/^https?:\/\//i.test(url)) return false;
        void shell.openExternal(url);
        return true;
    };
    // Panel placement, asked for by the conversation's own header and answered by
    // the console, which owns the state. Main only relays: it has no opinion on
    // which side the panel is, and keeping it that way means one source of truth.
    const toConsole = (channel: string, payload?: unknown) => {
        if (!mainView.webContents.isDestroyed()) mainView.webContents.send(channel, payload);
    };
    ipcMain.on("panel:set-side", (_, side: unknown) => {
        if (side === "left" || side === "right") toConsole("console:agent-side", side);
    });
    ipcMain.on("panel:toggle-detached", () => toConsole("console:agent-detach-toggle"));
    ipcMain.on("panel:request-placement", () => toConsole("console:agent-placement-request"));
    ipcMain.on("panel:request-theme", () => toConsole("console:agent-theme-request"));
    ipcMain.on("console:agent-theme", (_, theme: unknown) => {
        if (theme !== "dark" && theme !== "light") return;
        consoleTheme = theme;
        if (agentWin && !agentWin.isDestroyed()) {
            agentWin.webContents.send("panel:theme", theme);
        }
        // Settings is a plain window rather than part of the conversation, but it
        // is still this app's window and should not be the one thing left dark.
        if (settingsWin && !settingsWin.isDestroyed()) {
            settingsWin.setBackgroundColor(THEME_BG[theme]);
            settingsWin.webContents.send("settings:theme", theme);
        }
    });
    ipcMain.on("console:agent-placement", (_, placement: unknown) => {
        // Both windows show the same conversation and the same header, so both
        // need to know where it currently is — the detached one above all, since
        // its only useful placement control is the one that puts it back.
        if (agentWin && !agentWin.isDestroyed()) {
            agentWin.webContents.send("panel:placement", placement);
        }
    });

    win.on("closed", () => {
        // The detached conversation window rides on this window's harness process —
        // without it the page is dead, so it goes down with the ship.
        if (agentWin && !agentWin.isDestroyed()) agentWin.close();
        harnessViewLifecycle.stop();
        harnessAssetsWatcher?.close();
        backend?.terminalSessions.killAll();
        backend?.harness.stop();
        backend?.daemon.stop();
    });

    // Right-click editing menus on the main + overlay views.
    attachContextMenu(mainView.webContents);
    attachContextMenu(overlayView.webContents);

    // Detach the conversation into its own window. A second request while detached
    // closes that window (a toggle); the console re-embeds its panel on the
    // "agent:attached" signal, which fires however the window ends up closing.
    let agentWin: BrowserWindow | null = null;
    ipcMain.on("agent:detach", (e) => {
        if (agentWin && !agentWin.isDestroyed()) {
            agentWin.close();
            return;
        }
        agentWin = new BrowserWindow({
            width: Math.max(760, sidebarWidth),
            height: 900,
            minWidth: 480,
            minHeight: 400,
            title: "PiKVM — Conversation",
            backgroundColor: "#0a0a0c",
            autoHideMenuBar: true,
            webPreferences: {
                contextIsolation: true,
                // The same isolated session as the embedded view, and the same
                // placement bridge, so this window's own header can put the
                // conversation back where it came from.
                partition: HARNESS_PARTITION,
                preload: resolve(__dirname, "preload-agent.js"),
            },
        });
        agentWin.removeMenu();
        // Seeded once per window: sessionStorage does not travel between them,
        // so without this the detached conversation asked for a token that the
        // embedded panel had never needed.
        /* No auth seeding here any more. The sentinel used to be executed into
         * this window after load, which needed a reload to take; the workspace
         * bundle now carries it in host-config.js, so it is already set when the
         * app first looks. */
        void agentWin.loadURL(workspaceUrl());
        // Same navigation policy as the embedded harness view: keep the harness
        // origin in-window, kick everything else out to the system browser.
        agentWin.webContents.setWindowOpenHandler(({ url }) => {
            openUrlExternally(url);
            return { action: "deny" };
        });
        agentWin.webContents.on("will-navigate", (ev, url) => {
            if (url.startsWith(workspaceUrl())) return;
            ev.preventDefault();
            openUrlExternally(url);
        });
        attachContextMenu(agentWin.webContents);
        const sender = e.sender;
        agentWin.on("closed", () => {
            agentWin = null;
            if (!sender.isDestroyed()) sender.send("agent:attached");
        });
    });

    // Drag-to-resize the sidebar: the renderer sends the desired width.

    // Start the local backend (PiKVM control core for the proxy + the shared
    // terminal + the control server) — UNLESS we're a thin client pointing at a
    // remote console, where the remote host owns the proxy + terminal.
    const backend = remoteConsole
        ? null
        : startProxyAndHarness(origin, settings, harnessCommand);
    const harnessAssetDirectory =
        !app.isPackaged && backend
            ? resolveDevHarnessAssetDirectory(harnessCommand)
            : null;
    const harnessAssetsWatcher = harnessAssetDirectory
        ? watch(harnessAssetDirectory, { persistent: false }, () => {
              harnessViewLifecycle.scheduleAssetReload(() => {
                  console.log(
                      `[harness-renderer] reloading rebuilt UI from ${harnessAssetDirectory}`,
                  );
                  /* The workspace is a frame in the console now, so the console
                   * reloads it. Left pointing at the native view, a rebuild
                   * would have refreshed the copy nobody looks at and left the
                   * visible one stale — a dev convenience that quietly stopped
                   * conveniencing anything. */
                  toConsole("console:workspace-reload");
                  if (agentWin && !agentWin.isDestroyed()) {
                      agentWin.webContents.reloadIgnoringCache();
                  }
              });
          })
        : null;
    harnessAssetsWatcher?.on("error", (error) =>
        console.error(
            `[harness-renderer] asset watcher failed: ${String(error)}`,
        ),
    );

    if (backend) {
        // The React workspace still uses its normal token-auth client, but only
        // sees a non-secret sentinel. Electron replaces that header inside this
        // isolated session, keeping approval authority out of renderer storage.
        /* The session header rewrite lived here, swapping a sentinel for the
         * real operator token on requests to the harness origin. Nothing in a
         * renderer talks to that origin any more: both the embedded frame and
         * the detached window load from ours, and their API goes through the
         * /_agent/harness proxy, which attaches the credential server-side and
         * never lets it reach a page at all. A rewrite that can no longer fire
         * is not defence in depth, it is a claim about how auth works that
         * stopped being true. */
    }

    if (backend) {
        /* Nothing to load here any more: the conversation is rendered in the
         * console page, which waits for the harness itself and retries there.
         * Still worth reporting, because the console can only say "not yet"
         * while this knows the harness never started at all. */
        void backend.harnessReady.catch((error: unknown) => {
            const detail =
                error instanceof Error ? error.message : String(error ?? "unknown error");
            console.error(`[harness] never became ready: ${detail}`);
        });
    }


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
        if (useConsole) {
            // The unified console is the primary UI; it proxies to the Pi itself and
            // draws its OWN titlebar (window controls + agent toggle + audio/mic +
            // fit-native), so it fills the whole window (no ui.html titlebar).
            console.log("Loading unified console at:", CONSOLE_URL);
            mainView.webContents.loadURL(CONSOLE_URL);
            return;
        }
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
            const p = new URL(wc.getURL()).pathname;
            // The unified console (default) always shows the live KVM screen; the
            // legacy native UI only does on its /kvm page.
            onKVM = useConsole ? p.startsWith("/_agent/console") : p.startsWith("/kvm");
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

        if (useConsole) {
            // The console IS the full primary UI — always a big, resizable, maximisable
            // window. Never fall into the legacy compact "normal mode" (400×350).
            canMaximize = true;
            win.setMaximizable(true);
            win.setClosable(true);
            win.setResizable(true);
            return;
        }

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
            lastStreamData.width,
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

                win.setContentSize(data.width, data.height + TITLEBAR_HEIGHT);
                setTimeout(() => {
                    layout();
                }, 100);
            }

            // Track the native stream resolution on the control core.
            if (data.width && data.height) backend?.control.setNativeDims(data.width, data.height);

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
    // Console mode draws its own titlebar/chrome, so the native ui.html overlay
    // (legacy titlebar + connect screen) is hidden and not loaded.
    if (useConsole) {
        overlayView.setVisible(false);
    } else {
        overlayView.webContents.loadFile(resolve(__dirname, "views", "ui.html"));
        overlayView.webContents.setIgnoreMenuShortcuts(true);
        overlayView.webContents.setVisualZoomLevelLimits(1, 1);
    }

    sendWindowState();

    // Console mode: the main view IS the unified console from boot. Otherwise show
    // the legacy settings/connect screen and let ui.html drive the KVM connect.
    if (useConsole) connect();
    else mainView.webContents.loadFile(resolve(__dirname, "views", "settings.html"));

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
            if (!isMainFrame || errorCode === -3) return; // ignore sub-resources + aborts
            console.log("Main view failed to load:", errorCode, errorDescription, validatedURL);
            if (useConsole) {
                // Local server may just be starting on first boot — keep retrying.
                if (!remoteConsole) {
                    setTimeout(connect, 600);
                    return;
                }
                // REMOTE console unreachable → the user can't reach in-app Settings,
                // so give a NATIVE recovery dialog (independent of the dead frontend).
                consoleLoadFails++;
                if (consoleLoadFails < 3) {
                    setTimeout(connect, 1200);
                    return;
                }
                consoleLoadFails = 0;
                if (!win.isDestroyed() && !win.isVisible()) win.show();
                void dialog
                    .showMessageBox(win, {
                        type: "error",
                        title: "Can't reach the console",
                        message: `Couldn't load the console from:\n${CONSOLE_ORIGIN}`,
                        detail: (errorDescription || "The server may be down or the address may be wrong.") + "\n\nUse the local server to get back in and fix the address in Settings → Connection.",
                        buttons: ["Retry", "Use local server", "Quit"],
                        defaultId: 0,
                        cancelId: 2,
                    })
                    .then((r) => {
                        if (r.response === 1) {
                            const cfg = loadConfig();
                            delete cfg.consoleOrigin; // back to local
                            saveConfig(cfg);
                            app.relaunch();
                            app.exit(0);
                        } else if (r.response === 2) {
                            app.quit();
                        } else {
                            connect();
                        }
                    });
                return;
            }
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
