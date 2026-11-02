import { BrowserWindow, ipcMain, Menu, powerSaveBlocker, session, shell, type MenuItemConstructorOptions } from "electron";
import { resolve } from "node:path";
import { CHANNELS, VERSION_ARG } from "./channels";
import { externalUrl, navigationVerdict } from "./policy";
import { setDisplayBlocker } from "./display-blocker";
import { requestAttention } from "../taskbar-attention";

/* The one app window: the embedded server's /app/ in a frameless BrowserWindow.
 *
 * Linux and Windows draw no frame, because the web app has its own titlebar and its own window
 * controls. macOS keeps the traffic lights over the page's titlebar (hidden title bar), which is
 * what `nativeControls` in the bridge tells the page. */

const BACKGROUND = "#0a0a0c";
const SIZE = { width: 1400, height: 880, minWidth: 900, minHeight: 560 } as const;

export interface AppWindowOptions {
    /** The page to load, e.g. http://127.0.0.1:25650/app/. */
    readonly url: string;
    readonly icon: string;
    readonly version: string;
}

/** Window controls and links, for whichever window sent the message. Registered once. */
let ipcRegistered = false;

function windowOf(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
}

/**
 * Full screen for the page. Plain full screen is the window's. With the keyboard locked it has to
 * be the page's own HTML full screen, because Chromium only grants Keyboard Lock to a document in
 * full screen; Electron turns that request into native window full screen as well. The main process
 * asks from here, with a user gesture, because the page asked us.
 */
async function setFullscreen(win: BrowserWindow, on: boolean, lockKeyboard: boolean): Promise<boolean> {
    const page = win.webContents;
    if (on && lockKeyboard) {
        await page
            .executeJavaScript(
                `document.documentElement.requestFullscreen({ navigationUI: "hide" })
                    .then(() => navigator.keyboard?.lock?.())`,
                true,
            )
            .catch(() => undefined);
        if (!win.isFullScreen()) win.setFullScreen(true);
    } else if (on) {
        win.setFullScreen(true);
    } else {
        await page
            .executeJavaScript(`navigator.keyboard?.unlock?.(); document.fullscreenElement ? document.exitFullscreen() : undefined`, true)
            .catch(() => undefined);
        if (win.isFullScreen()) win.setFullScreen(false);
    }
    return win.isFullScreen();
}

function registerIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.on(CHANNELS.minimise, (e) => windowOf(e)?.minimize());
    ipcMain.on(CHANNELS.toggleMaximise, (e) => {
        const win = windowOf(e);
        if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
    });
    ipcMain.on(CHANNELS.close, (e) => windowOf(e)?.close());
    ipcMain.handle(CHANNELS.isMaximised, (e) => windowOf(e)?.isMaximized() ?? false);
    ipcMain.handle(CHANNELS.isFullscreen, (e) => windowOf(e)?.isFullScreen() ?? false);
    ipcMain.handle(CHANNELS.setFullscreen, (e, on: unknown, lockKeyboard: unknown) => {
        const win = windowOf(e);
        return win ? setFullscreen(win, on === true, lockKeyboard === true) : false;
    });
    ipcMain.on(CHANNELS.keepDisplayAwake, (e, on: unknown) => {
        const win = windowOf(e);
        if (win) setDisplayBlocker(win.id, on === true, powerSaveBlocker);
    });
    // Re-checked there: focus can land between the page's sample and this message arriving.
    ipcMain.on(CHANNELS.requestAttention, (e) => {
        const win = windowOf(e);
        if (win) requestAttention(win);
    });
    /* Tell the page whether a download actually landed. Clicking an <a download> only HANDS the
     * file to the download machinery: it can open a save dialog the user cancels, or fail on a
     * full or read-only disk, and a page that toasts "saved" on the click reports an outcome it
     * never observed. */
    session.defaultSession.on("will-download", (_event, item, page) => {
        item.once("done", (_done, state) => {
            if (page.isDestroyed()) return;
            page.send(CHANNELS.downloadDone, {
                name: item.getFilename(),
                state,
                path: state === "completed" ? item.getSavePath() : "",
            });
        });
    });
    ipcMain.handle(CHANNELS.openExternal, async (_e, url: unknown) => {
        const target = typeof url === "string" ? externalUrl(url) : null;
        if (!target) throw new Error("Only http, https and mailto links can be opened");
        await shell.openExternal(target);
    });
}

/** Cut, copy, paste and select all where there is something to act on. */
function attachEditMenu(page: Electron.WebContents): void {
    page.on("context-menu", (_event, params) => {
        const flags = params.editFlags;
        const template: MenuItemConstructorOptions[] = [];
        if (params.isEditable) {
            template.push(
                { role: "cut", enabled: flags.canCut },
                { role: "copy", enabled: flags.canCopy },
                { role: "paste", enabled: flags.canPaste },
                { type: "separator" },
                { role: "selectAll" },
            );
        } else if (params.selectionText) {
            template.push({ role: "copy" }, { role: "selectAll" });
        }
        if (template.length > 0) Menu.buildFromTemplate(template).popup();
    });
}

/**
 * The application menu. The default one binds Ctrl+W, Ctrl+R and Ctrl+Shift+I, which on a KVM
 * are keys for the TARGET, not for this window, so Linux and Windows get none. macOS needs a
 * menu for Cmd+Q and the edit shortcuts to work at all, so it gets the bare minimum.
 */
function setApplicationMenu(): void {
    if (process.platform !== "darwin") {
        Menu.setApplicationMenu(null);
        return;
    }
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: "appMenu" },
            { role: "editMenu" },
            { role: "windowMenu" },
        ]),
    );
}

export function createAppWindow(options: AppWindowOptions): BrowserWindow {
    registerIpc();
    setApplicationMenu();

    const win = new BrowserWindow({
        ...SIZE,
        center: true,
        darkTheme: true,
        icon: options.icon,
        title: "PiKVM Desktop",
        backgroundColor: BACKGROUND,
        // Revealed once the page has painted, so there is no white flash on launch.
        show: false,
        ...(process.platform === "darwin"
            ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 13, y: 10 } }
            : { frame: false }),
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            preload: resolve(__dirname, "preload.js"),
            additionalArguments: [`${VERSION_ARG}${options.version}`],
            // The page runs capture and heartbeat timers that must not slow down behind another window.
            backgroundThrottling: false,
        },
    });

    const page = win.webContents;
    const appOrigin = new URL(options.url).origin;
    const send = (channel: string, value: boolean): void => {
        if (!win.isDestroyed()) page.send(channel, value);
    };
    const windowId = win.id;
    win.on("closed", () => setDisplayBlocker(windowId, false, powerSaveBlocker));
    win.on("maximize", () => send(CHANNELS.maximiseChange, true));
    win.on("unmaximize", () => send(CHANNELS.maximiseChange, false));
    win.on("enter-full-screen", () => send(CHANNELS.fullscreenChange, true));
    win.on("leave-full-screen", () => send(CHANNELS.fullscreenChange, false));
    win.on("focus", () => send(CHANNELS.focusChange, true));
    win.on("blur", () => send(CHANNELS.focusChange, false));

    // No second window of ours, ever: a link either goes to the browser or goes nowhere.
    page.setWindowOpenHandler(({ url }) => {
        const target = externalUrl(url);
        if (target) void shell.openExternal(target);
        return { action: "deny" };
    });
    page.on("will-navigate", (event, url) => {
        const verdict = navigationVerdict(appOrigin, url);
        if (verdict === "allow") return;
        event.preventDefault();
        const target = verdict === "external" ? externalUrl(url) : null;
        if (target) void shell.openExternal(target);
    });
    // A leave-page prompt would trap the window open with nobody to answer it.
    page.on("will-prevent-unload", (event) => event.preventDefault());
    // Ctrl+scroll and pinch would zoom the page chrome; the app has its own zoom for the picture.
    page.on("zoom-changed", () => {
        page.setVisualZoomLevelLimits(1, 1);
        page.setZoomLevel(0);
    });
    attachEditMenu(page);

    if (process.env.NODE_ENV === "development" || process.env.DEVTOOLS === "1") page.openDevTools({ mode: "detach" });
    return win;
}

/** Bring the existing window forward, for a second launch. */
export function focusAppWindow(): void {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}
