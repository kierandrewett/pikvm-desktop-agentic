import { contextBridge, ipcRenderer } from "electron";

/**
 * Bridge for the unified console rendered as a *desktop* Electron window
 * (`openUnifiedConsole()` in main.ts). The console UI is normally served to a
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
     * resolution 1:1 (no black bars). The main process accounts for the titlebar
     * height and the agent panel width (when shown). Pass `agentPanelWidth: 0`
     * when the panel is collapsed.
     */
    fitNative(opts: { width: number; height: number; agentPanelWidth: number; titlebarHeight: number }): void;
    /**
     * Pop a NATIVE Electron context menu built from `items`. The chosen item's
     * `id` is delivered via `onMenuCommand`. `anchor` (optional) positions it;
     * omit to pop at the cursor.
     */
    popupMenu(items: DesktopMenuItem[], anchor?: { x: number; y: number }): void;
    /** Subscribe to native-menu command picks; returns an unsubscribe fn. */
    onMenuCommand(cb: (id: string) => void): () => void;
}

const api: DesktopConsoleApi = {
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
};

contextBridge.exposeInMainWorld("desktopConsole", api);
