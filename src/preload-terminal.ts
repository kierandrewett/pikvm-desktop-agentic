import { clipboard, contextBridge } from "electron";

// The embedded terminal is otherwise preload-less (a plain HTTP web client). This bridges
// ONLY the system clipboard so copy/paste works inside the sandboxed WebContentsView — the
// renderer can't reach Electron's clipboard, and navigator.clipboard.readText() is
// unreliable behind Electron's permission model. Nothing else is exposed.
contextBridge.exposeInMainWorld("termClipboard", {
    readText: (): string => clipboard.readText(),
    writeText: (text: string): void => clipboard.writeText(String(text ?? "")),
});
