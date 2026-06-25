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
import { readFileSync, existsSync, writeFileSync, statSync } from "fs";
import { resolve, isAbsolute, extname } from "path";
import { PiKvmControl } from "./pikvm-control";
import { electronImageOps } from "./image-ops-electron";
import { startControlServer } from "./server";
import { SettingsStore } from "./settings";
import { TerminalSessions } from "./terminal-server";

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
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 640;

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
// "hidden", positioned to sit inside our 34px titlebar); Linux + Windows are fully
// frameless so the console draws its own controls (GTK-style on Linux).
const consoleFrameOpts: Electron.BrowserWindowConstructorOptions =
    process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 13, y: 10 } } : { frame: false };

/** Start the PiKVM backend: the control core (for the reverse proxy's target), the
 *  shared terminal sessions, and the control server that hosts the proxy + terminal
 *  WebSocket + static console assets. Returns what the window wiring needs. */
function startProxyAndTerminal(origin: string, settings: SettingsStore) {
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

    // ---- Server-hosted terminal sessions — the PTYs live here and stream to ALL
    // devices over the /_agent/terminal WebSocket (desktop + mobile see the same tabs). ----
    const vaultPath = (): string => {
        const p = settings.get().atlas?.vaultPath;
        return p && p.trim() ? p : app.getPath("home");
    };
    const resolvePath = (p: string): string => {
        if (p.startsWith("~/")) return resolve(app.getPath("home"), p.slice(2));
        return isAbsolute(p) ? p : resolve(vaultPath(), p);
    };
    const IMG_MIME: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
    };
    const terminalSessions = new TerminalSessions({
        vaultPath,
        port: CONTROL_PORT,
        prepareAgent: () => {
            /* plain shell terminal — no agent environment to prepare */
        },
        resolveImage: (p) => {
            try {
                const abs = resolvePath(p);
                const mime = IMG_MIME[extname(abs).toLowerCase()];
                if (!mime || !existsSync(abs)) return null;
                if (statSync(abs).size > 12 * 1024 * 1024) return null;
                return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
            } catch {
                return null;
            }
        },
        openPath: (p) => {
            const abs = resolvePath(p);
            if (existsSync(abs)) void shell.openPath(abs);
        },
        openExternal: (u) => {
            if (/^https?:\/\//i.test(u)) void shell.openExternal(u);
        },
    });

    startControlServer({ control, settings, terminalSessions }, CONTROL_PORT, bindHost);
    console.log(`PiKVM backend listening on http://${bindHost}:${CONTROL_PORT} (UI proxy + /_agent/*)`);
    return { control, settings, terminalSessions };
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

/** The console origin the desktop loads from (Settings → Connection, or the env
 *  override, else the local server). */
function resolvedConsoleOrigin(): string {
    let saved: string | undefined;
    try {
        saved = loadConfig().consoleOrigin;
    } catch {
        /* no config yet */
    }
    return (saved || process.env.PIKVM_CONSOLE_ORIGIN || `http://127.0.0.1:${CONTROL_PORT}`).replace(/\/$/, "");
}

// ── Console window IPC (only the frameless console carries preload-console) ──
// Read/write the console origin (a desktop-level setting; changing it relaunches).
ipcMain.on("console:get-origin", (e) => {
    const origin = resolvedConsoleOrigin();
    let pikvmOrigin = "https://pikvm/";
    try {
        pikvmOrigin = loadConfig().origin || pikvmOrigin;
    } catch {
        /* no config yet */
    }
    e.returnValue = { origin, isLocal: origin === `http://127.0.0.1:${CONTROL_PORT}`, envLocked: !!process.env.PIKVM_CONSOLE_ORIGIN, pikvmOrigin };
});
// Set where the LOCAL backend reaches the PiKVM (creds may be in the URL). Relaunch.
ipcMain.on("console:set-pikvm-origin", (e, url: unknown) => {
    if (!consoleWinFrom(e)) return;
    const u = typeof url === "string" ? url.trim().replace(/\/$/, "") : "";
    if (!u) return;
    const cfg = loadConfig();
    cfg.origin = u;
    saveConfig(cfg);
    app.relaunch();
    app.exit(0);
});
ipcMain.on("console:set-origin", (e, origin: unknown) => {
    if (!consoleWinFrom(e)) return;
    const cfg = loadConfig();
    const o = typeof origin === "string" ? origin.trim().replace(/\/$/, "") : "";
    // Empty / the local server → clear it (back to local mode).
    if (o && o !== `http://127.0.0.1:${CONTROL_PORT}`) cfg.consoleOrigin = o;
    else delete cfg.consoleOrigin;
    saveConfig(cfg);
    app.relaunch();
    app.exit(0);
});
ipcMain.on("console:minimise", (e) => consoleWinFrom(e)?.minimize());
ipcMain.on("console:toggle-maximise", (e) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on("console:close", (e) => consoleWinFrom(e)?.close());
ipcMain.handle("console:is-maximised", (e) => {
    const w = consoleWinFrom(e);
    return !!w && w.isMaximized();
});

// Snap the window so the live-screen area renders the native resolution 1:1. The
// renderer passes the stream's native size, the agent-panel width (0 if collapsed)
// and the titlebar height it drew; we add those to the screen size and set the
// window's CONTENT size (excludes the OS frame — and we're frameless anyway).
ipcMain.on("console:fit-native", (e, opts: { width?: number; height?: number; agentPanelWidth?: number; titlebarHeight?: number }) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    const nw = Number(opts?.width);
    const nh = Number(opts?.height);
    if (!nw || !nh || nw < 1 || nh < 1) return;
    const panel = Math.max(0, Math.round(Number(opts?.agentPanelWidth) || 0));
    const bar = Math.max(0, Math.round(Number(opts?.titlebarHeight) || 0));
    if (w.isMaximized()) w.unmaximize();
    // The agent panel + titlebar are FIXED-pixel chrome (they don't scale), so we
    // scale only the SCREEN to fit the work area beside them, then add them back.
    // This makes the screen column land exactly on the stream aspect — no black bars.
    const area = screen.getDisplayMatching(w.getBounds()).workAreaSize;
    const availW = Math.max(320, area.width - panel);
    const availH = Math.max(240, area.height - bar);
    const scale = Math.min(1, availW / nw, availH / nh);
    const screenW = Math.round(nw * scale);
    const screenH = Math.round(nh * scale);
    w.setContentSize(screenW + panel, screenH + bar);
});

// Grow/shrink the window by a delta (toggling the agent panel) so the KVM screen
// keeps its exact size — the window changes width by the panel's width instead.
ipcMain.on("console:resize-by", (e, opts: { dw?: number; dh?: number }) => {
    const w = consoleWinFrom(e);
    if (!w || w.isMaximized()) return; // pointless while maximised
    const dw = Math.round(Number(opts?.dw) || 0);
    const dh = Math.round(Number(opts?.dh) || 0);
    const size = w.getContentSize();
    const cw = size[0] ?? 0;
    const ch = size[1] ?? 0;
    const area = screen.getDisplayMatching(w.getBounds()).workAreaSize;
    // setContentSize keeps the top-left anchored, so the screen (on the left) stays put.
    w.setContentSize(Math.max(480, Math.min(area.width, cw + dw)), Math.max(360, Math.min(area.height, ch + dh)));
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

    // The embedded shared terminal. Its own WebContentsView, loaded over HTTP from our
    // backend so it's same-origin with the /_agent/terminal WebSocket it drives — the
    // SAME page mobile loads. Positioned over the console's terminal-panel region. Never
    // throttled. No preload: it's a plain web client, no IPC.
    const terminalView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });
    terminalView.setBackgroundColor("#0a0a0c");
    terminalView.setVisible(false);

    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));

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
    let sidebarOpen = false;
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
    win.contentView.addChildView(terminalView);

    const layout = () => {
        const [w, h] = win.getContentSize();
        console.log(`Layout: ${w}x${h}`);

        // The console hosts its own terminal panel, so the native sidebar is not used
        // in console mode — the main view (the console) spans full width.
        const sbW = useConsole ? 0 : sidebarOpen ? sidebarWidth : 0;

        // The console draws its OWN titlebar, so the main view fills the whole window.
        const topY = useConsole ? 0 : TITLEBAR_HEIGHT;
        mainView.setBounds({
            x: 0,
            y: topY,
            width: w! - sbW,
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

    // The terminal renderer is loaded over HTTP (once the backend is up, below) so it's
    // same-origin with the /_agent/terminal WebSocket it connects to — the SAME page the
    // mobile/web console loads, so every device shares the server-hosted sessions.
    terminalView.webContents.on("console-message", (_e, level, message, line, src) => {
        console.log(`[term-renderer:${level}] ${message} (${src}:${line})`);
    });
    terminalView.webContents.on("did-fail-load", (_e, code, desc, url) => {
        console.error(`[term-renderer] did-fail-load ${code} ${desc} ${url}`);
        // The backend may not have bound yet on first paint — retry the load shortly.
        if (!terminalView.webContents.isDestroyed())
            setTimeout(() => {
                if (!terminalView.webContents.isDestroyed())
                    void terminalView.webContents.loadURL(`http://127.0.0.1:${CONTROL_PORT}/_agent/terminal.html`);
            }, 500);
    });
    terminalView.webContents.on("render-process-gone", (_e, details) => {
        console.error(`[term-renderer] render-process-gone`, details);
    });
    const openTerminalUrlExternally = (url: string): boolean => {
        if (!/^https?:\/\//i.test(url)) return false;
        void shell.openExternal(url);
        return true;
    };
    terminalView.webContents.setWindowOpenHandler(({ url }) => {
        openTerminalUrlExternally(url);
        return { action: "deny" };
    });
    terminalView.webContents.on("will-navigate", (e, url) => {
        const own = url.startsWith(`http://127.0.0.1:${CONTROL_PORT}/_agent/`);
        if (own) return;
        e.preventDefault();
        openTerminalUrlExternally(url);
    });
    // Never page-zoom the terminal (it breaks the xterm layout); the renderer maps Ctrl+/-/0
    // to font size instead. Lock the Electron zoom level as a backstop.
    terminalView.webContents.on("zoom-changed", () => terminalView.webContents.setZoomLevel(0));
    terminalView.webContents.on("did-finish-load", () => {
        terminalView.webContents.setZoomLevel(0);
        terminalView.webContents.setVisualZoomLevelLimits(1, 1);
        requestTerminalFit();
    });
    let terminalFitTimer: NodeJS.Timeout | null = null;
    const requestTerminalFit = () => {
        const wc = terminalView.webContents;
        if (wc.isDestroyed()) return;
        const run = () => {
            if (wc.isDestroyed()) return;
            void wc
                .executeJavaScript(
                    'window.dispatchEvent(new Event("resize")); window.postMessage({ type: "terminal-fit" }, "*"); window.__pikvmTerminalFit?.();',
                    true,
                )
                .catch(() => {});
        };
        run();
        if (terminalFitTimer) clearTimeout(terminalFitTimer);
        terminalFitTimer = setTimeout(run, 80);
    };

    // Any external task → type it into the primary terminal session.
    ipcMain.on("console:run-task", (_, task: unknown) => {
        if (typeof task === "string" && task.trim() && backend)
            backend.terminalSessions.submitLine(backend.terminalSessions.primaryId(), task.trim());
    });
    // The console reports where its terminal-panel content sits (window pixels); we float the
    // terminal view there. Empty/zero → hide it (panel collapsed). The renderer re-fits on
    // its own resize events when these bounds change.
    let termRectSeen = false;
    ipcMain.on("console:terminal-rect", (_, r: { x?: number; y?: number; width?: number; height?: number }) => {
        const x = Math.round(Number(r?.x) || 0);
        const y = Math.round(Number(r?.y) || 0);
        const width = Math.round(Number(r?.width) || 0);
        const height = Math.round(Number(r?.height) || 0);
        if (width > 1 && height > 1) {
            if (!termRectSeen) { console.log(`[console:terminal-rect] first show ${width}x${height} @${x},${y}`); termRectSeen = true; }
            terminalView.setVisible(true);
            terminalView.setBounds({ x, y, width, height });
            requestTerminalFit();
        } else {
            terminalView.setVisible(false);
        }
    });
    win.on("closed", () => {
        backend?.terminalSessions.killAll();
    });

    // Right-click editing menus on the main + overlay views.
    attachContextMenu(mainView.webContents);
    attachContextMenu(overlayView.webContents);

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

    // Start the local backend (PiKVM control core for the proxy + the shared
    // terminal + the control server) — UNLESS we're a thin client pointing at a
    // remote console, where the remote host owns the proxy + terminal.
    const backend = remoteConsole ? null : startProxyAndTerminal(origin, settings);

    // Now that the backend is listening, load the shared terminal renderer over HTTP so it's
    // same-origin with its /_agent/terminal WebSocket (the desktop view and mobile both use it).
    void terminalView.webContents.loadURL(`http://127.0.0.1:${CONTROL_PORT}/_agent/terminal.html`);

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

            // Left the KVM screen — collapse the sidebar so it isn't stranded open
            // without its (now-hidden) toggle button.
            if (sidebarOpen) {
                sidebarOpen = false;
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
