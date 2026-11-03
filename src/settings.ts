/**
 * Persisted app settings (keyboard layout, jiggler, server
 * bind/auth, sidebar width). Stored as JSON in the app's
 * userData and applied on startup so preferences survive restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "node:path";

export interface AppSettings {
    /** Idle mouse-jiggler: nudge the cursor every ~60s of inactivity to keep the
     *  target awake (restores the exact position). */
    jiggler: boolean;
    /** Target keyboard layout (sets glyphs for the physical key codes sent). */
    keyboardLayout: "us" | "uk";
    /** Host the control server + proxy binds to. "0.0.0.0" exposes it on the LAN. */
    bindHost: string;
    /** Single access token gating the server when set. Empty = open (loopback dev). */
    accessToken: string;
}

const DEFAULTS: AppSettings = {
    jiggler: true,
    keyboardLayout: "us",
    bindHost: "127.0.0.1",
    accessToken: "",
};

export class SettingsStore {
    private data: AppSettings;

    /** Directory the settings (and sibling stores/logs) live in. */
    dir(): string {
        return dirname(this.path);
    }

    constructor(private readonly path: string) {
        this.data = { ...DEFAULTS };
        if (existsSync(path)) {
            try {
                const saved = JSON.parse(readFileSync(path, "utf-8"));
                this.data = { ...DEFAULTS, ...saved };
            } catch {
                /* keep defaults */
            }
        }
    }

    get(): AppSettings {
        return { ...this.data };
    }

    patch(partial: Partial<AppSettings>): AppSettings {
        this.data = { ...this.data, ...partial };
        try {
            writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch {
            /* best-effort */
        }
        return this.get();
    }
}
