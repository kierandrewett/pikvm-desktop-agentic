import { contextBridge, ipcRenderer } from "electron";

// Bridge for the embedded Claude Code terminals. The renderer (xterm.js) drives the
// per-tab PTYs in the main process: keystrokes out, CLI output in, plus resize. Every
// call carries a session id so multiple tabs (each its own `claude`) can run at once.
contextBridge.exposeInMainWorld("desktopTerminal", {
    start: (id: string, agent?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("terminal:start", id, agent),
    write: (id: string, data: string): void => ipcRenderer.send("terminal:input", id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send("terminal:resize", id, cols, rows),
    kill: (id: string): void => ipcRenderer.send("terminal:kill", id),
    setActive: (id: string): void => ipcRenderer.send("terminal:set-active", id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
        const h = (_: unknown, id: string, data: string) => cb(id, data);
        ipcRenderer.on("terminal:data", h);
        return () => ipcRenderer.removeListener("terminal:data", h);
    },
    onExit: (cb: (id: string, info: { code: number; signal?: number }) => void): (() => void) => {
        const h = (_: unknown, id: string, info: { code: number; signal?: number }) => cb(id, info);
        ipcRenderer.on("terminal:exit", h);
        return () => ipcRenderer.removeListener("terminal:exit", h);
    },
    // Main fires this when it shows/resizes the floating terminal view, so the renderer can
    // re-fit (the initial fit can run while the view is hidden / zero-sized).
    onRelayout: (cb: () => void): (() => void) => {
        const h = () => cb();
        ipcRenderer.on("terminal:relayout", h);
        return () => ipcRenderer.removeListener("terminal:relayout", h);
    },
    // Ctrl/Cmd+click handlers: a URL opens in the browser; a file path opens in the OS
    // default app (resolved against the vault cwd in main).
    openLink: (url: string): void => ipcRenderer.send("terminal:open-link", url),
    openPath: (path: string): void => ipcRenderer.send("terminal:open-path", path),
    // Read an image file (resolved against the vault) for the hover preview; returns a
    // data URL or null if it's not a readable image.
    readImage: (path: string): Promise<string | null> => ipcRenderer.invoke("terminal:read-image", path),
});
