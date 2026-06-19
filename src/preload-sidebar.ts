import { contextBridge, ipcRenderer } from "electron";

// The desktop sidebar is loaded from a file:// page, so it has no useful origin
// of its own. Point it at the in-process control server explicitly; the web
// client falls back to same-origin (it is served by the proxy).
contextBridge.exposeInMainWorld("__AGENT_ORIGIN__", "http://127.0.0.1:25650");

// Minimal bridge: the sidebar mostly talks to the local control server over
// HTTP; it only needs window state for theming + a toggle channel.
contextBridge.exposeInMainWorld("ui", {
    send: (c: string, ...args: any[]) => ipcRenderer.send(c, ...args),
    on: (c: string, cb: (...args: any[]) => void) => ipcRenderer.on(c, (_, ...args) => cb(...args)),
    onState: (cb: (s: any) => void) => ipcRenderer.on("window:state", (_, s) => cb(s)),
    copy: (text: string) => ipcRenderer.send("clipboard:write", text),
});
