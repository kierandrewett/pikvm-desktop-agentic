import { contextBridge, ipcRenderer } from "electron";

// Bridge for the floating meeting-copilot overlay. It talks to the control
// server directly over HTTP/SSE; it only needs main for window mechanics
// (dragging the view, resizing it to its content, and dismissing it).
contextBridge.exposeInMainWorld("copilot", {
    base: "http://127.0.0.1:25650/_agent",
    drag: (dx: number, dy: number) => ipcRenderer.send("copilot:drag", { dx, dy }),
    resize: (height: number) => ipcRenderer.send("copilot:resize", { height }),
    close: () => ipcRenderer.send("copilot:close"),
});
