import { contextBridge, ipcRenderer } from "electron";

// Minimal bridge: the sidebar mostly talks to the local control server over
// HTTP; it only needs window state for theming + a toggle channel.
contextBridge.exposeInMainWorld("ui", {
    send: (c: string, ...args: any[]) => ipcRenderer.send(c, ...args),
    on: (c: string, cb: (...args: any[]) => void) => ipcRenderer.on(c, (_, ...args) => cb(...args)),
    onState: (cb: (s: any) => void) => ipcRenderer.on("window:state", (_, s) => cb(s)),
});
