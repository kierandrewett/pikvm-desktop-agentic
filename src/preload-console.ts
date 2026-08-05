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
    /** Report where the first-party chat workspace belongs in the native shell. */
    reportWorkspaceRect(rect: { x: number; y: number; width: number; height: number }): void;
    /** Open Settings in its own window.
     *
     *  This took an id of "settings" | "ambient" | "history" and main ignored
     *  it, opening Settings whatever arrived. Monitor and History were panels
     *  of the in-app agent, which now lives in the daemon; no window has
     *  existed for either for some time, so a caller asking for one would have
     *  been handed Settings without a word. */
    openSettingsWindow(): void;
    /** Detach the conversation into its own window. A second call while detached
     *  closes that window instead (a toggle); re-attachment is signalled via
     *  onAgentAttached when the window closes, however it closes. */
    detachAgent(): void;
    /** Tell the conversation which theme the console is in; it shares the window. */
    reportAgentTheme(theme: "dark" | "light"): void;
    /** The conversation asking, on its first paint, which theme to be in. */
    onAgentThemeRequest(cb: () => void): () => void;
    /** Tell the conversation's own header where it currently sits. */
    reportAgentPlacement(placement: { side: "left" | "right"; detached: boolean }): void;
    /** Placement asks coming FROM that header: move to a side, detach/re-attach,
     *  or (on its first paint) simply report where things stand. */
    onAgentPlacementCommand(
        cb: (
            command:
                | { type: "side"; side: "left" | "right" }
                | { type: "toggle-detached" }
                | { type: "request" },
        ) => void,
    ): () => void;
    /** Fired when the detached conversation window closes — re-embed the panel. */
    onAgentAttached(cb: () => void): () => void;
    /** True WINDOW focus (from the main process), so the KVM mouse tracks window focus —
     *  not the console view's focus, which a focused terminal child view would steal. */
    onWindowFocus(cb: (focused: boolean) => void): () => void;
    /**
     * The remote screen changed meaningfully while this window was in the
     * background — pulse the taskbar/dock icon. The main process ignores it when
     * the window is focused, and clears the pulse as soon as the user focuses.
     */
    signalScreenChange(): void;
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
    reportWorkspaceRect: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.send("console:workspace-rect", rect),
    openSettingsWindow: () => ipcRenderer.send("console:open-settings"),
    detachAgent: () => ipcRenderer.send("agent:detach"),
    /* Panel placement is driven from the conversation's own header now, so the
     * console answers requests from it rather than owning the only buttons. */
    reportAgentPlacement: (placement: { side: "left" | "right"; detached: boolean }) =>
        ipcRenderer.send("console:agent-placement", placement),
    reportAgentTheme: (theme: "dark" | "light") =>
        ipcRenderer.send("console:agent-theme", theme),
    onAgentThemeRequest: (cb) => {
        const listener = () => cb();
        ipcRenderer.on("console:agent-theme-request", listener);
        return () => ipcRenderer.removeListener("console:agent-theme-request", listener);
    },
    onAgentPlacementCommand: (cb) => {
        const side = (_e: unknown, value: "left" | "right") => cb({ type: "side", side: value });
        const toggle = () => cb({ type: "toggle-detached" });
        const request = () => cb({ type: "request" });
        ipcRenderer.on("console:agent-side", side);
        ipcRenderer.on("console:agent-detach-toggle", toggle);
        ipcRenderer.on("console:agent-placement-request", request);
        return () => {
            ipcRenderer.removeListener("console:agent-side", side);
            ipcRenderer.removeListener("console:agent-detach-toggle", toggle);
            ipcRenderer.removeListener("console:agent-placement-request", request);
        };
    },
    onAgentAttached: (cb) => {
        const listener = () => cb();
        ipcRenderer.on("agent:attached", listener);
        return () => ipcRenderer.removeListener("agent:attached", listener);
    },
    onWindowFocus: (cb) => {
        const listener = (_e: unknown, focused: boolean) => cb(!!focused);
        ipcRenderer.on("kvm:input-enabled", listener);
        return () => ipcRenderer.removeListener("kvm:input-enabled", listener);
    },
    signalScreenChange: () => ipcRenderer.send("console:screen-activity"),
};

contextBridge.exposeInMainWorld("desktopConsole", api);
