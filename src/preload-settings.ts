import { contextBridge, ipcRenderer } from "electron";

/**
 * Bridge for the small native Settings window (opened from the console's gear).
 * The slim app is a pure PiKVM client, so Settings only carries what a client
 * needs: the PiKVM connection URL (creds may be in the URL), the keyboard
 * layout, and the idle mouse-jiggler. Saving relaunches the app so the new
 * origin/layout take effect cleanly (mirrors the existing origin-change flow).
 */

export interface SettingsValues {
    /** PiKVM origin the local backend connects to (e.g. https://user:pass@pikvm/). */
    pikvmUrl: string;
    keyboardLayout: "us" | "uk";
    jiggler: boolean;
}

export interface PikvmSettingsApi {
    /** Read current values to populate the form. */
    read(): SettingsValues & { envLocked: boolean };
    /** Persist values and relaunch the app. */
    save(values: SettingsValues): void;
    /** Close the window without saving. */
    cancel(): void;
}

const api: PikvmSettingsApi = {
    read: () => ipcRenderer.sendSync("settings:read"),
    save: (values) => ipcRenderer.send("settings:save", values),
    cancel: () => ipcRenderer.send("settings:cancel"),
};

contextBridge.exposeInMainWorld("pikvmSettings", api);
