import { contextBridge, ipcRenderer } from "electron";

/**
 * Bridge for the unified console rendered as a *desktop* Electron window
 * (`createWindow()` in main.ts). The console UI is normally served to a
 * phone/browser over plain HTTP and needs no IPC; this preload is ONLY injected
 * into the desktop window, so the console treats the presence of
 * `window.desktopConsole` as the single signal that it is running inside the
 * native shell. When this object is absent (any web/mobile client) the console
 * renders and behaves exactly as before — none of its desktop branches run.
 *
 * Keep the surface minimal and typed: window-chrome mechanics (the page draws a
 * custom frameless titlebar), a "fit to native resolution" snap, and a native
 * Electron context menu the renderer pops in place of its HTML `.more-menu`.
 */

/** A single entry in a native context menu built in the main process. */
export interface DesktopMenuItem {
    /** Command id sent back to the renderer when this item is chosen. */
    id?: string;
    /** Visible label (omit for separators). */
    label?: string;
    /** "normal" (default), "separator", or "checkbox". */
    type?: "normal" | "separator" | "checkbox";
    /** Checked state for checkbox items (reflects current console state). */
    checked?: boolean;
    /** Disable the item without hiding it. */
    enabled?: boolean;
}

export interface DesktopConsoleApi {
    /** Host OS — drives window-control style (gtk on linux, traffic lights on mac). */
    platform: NodeJS.Platform;
    /** Whether the OS draws native window controls (mac traffic lights) — then the
     *  console hides its own and only reserves space for them. */
    nativeControls: boolean;
    /** Minimise the console window. */
    minimise(): void;
    /** Toggle between maximised and restored. */
    toggleMaximise(): void;
    /** Close the console window. */
    close(): void;
    /** Current maximised state (for first paint of the maximise/restore glyph). */
    isMaximised(): Promise<boolean>;
    /** Subscribe to maximise/unmaximise; returns an unsubscribe fn. */
    onMaximiseChange(cb: (maximised: boolean) => void): () => void;
    /**
     * Resize the window so the live-screen area renders the given native stream
     * resolution 1:1 (no black bars).
     *
     * `chromeWidth`/`chromeHeight` are everything in the window that is not the
     * screen's content box — the agent column, the titlebar, the divider between
     * them. The renderer measures the leftover in one go rather than listing the
     * parts, so main adds back exactly what is there.
     */
    fitNative(opts: { width: number; height: number; chromeWidth: number; chromeHeight: number }): void;
    /**
     * Pop a NATIVE Electron context menu built from `items`. The chosen item's
     * `id` is delivered via `onMenuCommand`. `anchor` (optional) positions it;
     * omit to pop at the cursor.
     */
    popupMenu(items: DesktopMenuItem[], anchor?: { x: number; y: number }): void;
    /** Subscribe to native-menu command picks; returns an unsubscribe fn. */
    onMenuCommand(cb: (id: string) => void): () => void;
    /** Open Settings in its own window.
     *
     *  This took an id of "settings" | "ambient" | "history" and main ignored
     *  it, opening Settings whatever arrived. Monitor and History were panels
     *  of the in-app agent, which now lives in the daemon; no window has
     *  existed for either for some time, so a caller asking for one would have
     *  been handed Settings without a word. */
    openSettingsWindow(): void;
    /** Tell the desktop which theme the console is in, so its Settings window
     *  follows it. */
    reportAgentTheme(theme: "dark" | "light"): void;
    /** True WINDOW focus (from the main process), so the KVM mouse tracks window focus —
     *  not the console view's focus, which a focused terminal child view would steal. */
    onWindowFocus(cb: (focused: boolean) => void): () => void;
    /**
     * The remote screen changed meaningfully while this window was in the
     * background — pulse the taskbar/dock icon. The main process ignores it when
     * the window is focused, and clears the pulse as soon as the user focuses.
     */
    signalScreenChange(): void;
    /**
     * What actually happened to a download, once the download machinery is done
     * with it — completed, cancelled by the user at a save dialog, or
     * interrupted. Save screenshot used to claim success on the click that
     * merely started it. Absent in the web build, which has no main process to
     * ask; the console keeps its own fallback for that.
     */
    onDownloadDone(
        cb: (info: { name: string; state: "completed" | "cancelled" | "interrupted"; path: string }) => void,
    ): () => void;
}

const api: DesktopConsoleApi = {
    platform: process.platform,
    // macOS draws native traffic lights (window created with titleBarStyle:"hidden");
    // Linux/Windows are frameless so the console draws its own controls.
    nativeControls: process.platform === "darwin",
    minimise: () => ipcRenderer.send("console:minimise"),
    toggleMaximise: () => ipcRenderer.send("console:toggle-maximise"),
    close: () => ipcRenderer.send("console:close"),
    isMaximised: () => ipcRenderer.invoke("console:is-maximised") as Promise<boolean>,
    onMaximiseChange: (cb) => {
        const listener = (_e: unknown, maximised: boolean) => cb(maximised);
        ipcRenderer.on("console:maximise-change", listener);
        return () => ipcRenderer.removeListener("console:maximise-change", listener);
    },
    fitNative: (opts) => ipcRenderer.send("console:fit-native", opts),
    popupMenu: (items, anchor) => ipcRenderer.send("console:popup-menu", { items, anchor }),
    onMenuCommand: (cb) => {
        const listener = (_e: unknown, id: string) => cb(id);
        ipcRenderer.on("console:menu-command", listener);
        return () => ipcRenderer.removeListener("console:menu-command", listener);
    },
    openSettingsWindow: () => ipcRenderer.send("console:open-settings"),
    reportAgentTheme: (theme: "dark" | "light") =>
        ipcRenderer.send("console:agent-theme", theme),
    onWindowFocus: (cb) => {
        const listener = (_e: unknown, focused: boolean) => cb(!!focused);
        ipcRenderer.on("kvm:input-enabled", listener);
        return () => ipcRenderer.removeListener("kvm:input-enabled", listener);
    },
    signalScreenChange: () => ipcRenderer.send("console:screen-activity"),
    onDownloadDone: (cb) => {
        const listener = (
            _e: unknown,
            info: { name: string; state: "completed" | "cancelled" | "interrupted"; path: string },
        ) => cb(info);
        ipcRenderer.on("console:download-done", listener);
        return () => ipcRenderer.removeListener("console:download-done", listener);
    },
};

contextBridge.exposeInMainWorld("desktopConsole", api);
