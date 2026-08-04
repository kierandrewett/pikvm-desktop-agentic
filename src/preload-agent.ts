/**
 * Preload for the harness workspace view.
 *
 * The conversation is a native child view of the console window, so the controls
 * that PLACE it — which side it docks to, whether it rides in its own window —
 * used to live in the console's overflow menu, three clicks away from the panel
 * they act on. They belong in the panel's own header, beside everything else
 * about the conversation.
 *
 * The console still owns that state; this is only a way for the panel to ask for
 * a change and to hear the result. Deliberately narrow: two commands and one
 * subscription. No credentials, no filesystem, nothing about the target.
 */

import { contextBridge, ipcRenderer } from "electron";

/** Where the conversation currently sits. */
export interface PanelPlacement {
    side: "left" | "right";
    detached: boolean;
}

const api = {
    setSide: (side: "left" | "right") => ipcRenderer.send("panel:set-side", side),
    /** The console owns the theme; this panel shares its window, so it follows.
     *  Asks once on subscribe so the first paint is not the wrong colour. */
    onTheme: (cb: (theme: "dark" | "light") => void) => {
        const listener = (_e: unknown, theme: "dark" | "light") => cb(theme);
        ipcRenderer.on("panel:theme", listener);
        ipcRenderer.send("panel:request-theme");
        return () => ipcRenderer.removeListener("panel:theme", listener);
    },
    toggleDetached: () => ipcRenderer.send("panel:toggle-detached"),
    /** Subscribe to placement, and ask for it once so the first paint is right. */
    onPlacement: (cb: (placement: PanelPlacement) => void) => {
        const listener = (_e: unknown, placement: PanelPlacement) => cb(placement);
        ipcRenderer.on("panel:placement", listener);
        ipcRenderer.send("panel:request-placement");
        return () => ipcRenderer.removeListener("panel:placement", listener);
    },
};

export type PikvmPanelApi = typeof api;

contextBridge.exposeInMainWorld("pikvmPanel", api);
