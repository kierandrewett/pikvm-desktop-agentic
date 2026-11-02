/**
 * Persisted app settings (humanize intensity, keyboard layout, jiggler, server
 * bind/auth, sidebar width, terminal working dir). Stored as JSON in the app's
 * userData and applied on startup so preferences survive restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

export interface AppSettings {
    /** Typing humanity 0..1 (0 = no typos, full cadence; 1 = full human). */
    humanize: number;
    /** Idle mouse-jiggler: nudge the cursor every ~60s of inactivity to keep the
     *  target awake (restores the exact position). */
    jiggler: boolean;
    /** Baseline typing WPM the random persona centers on. */
    wpm: number;
    /** Target keyboard layout (sets glyphs for the physical key codes sent). */
    keyboardLayout: "us" | "uk";
    /** Host the control server + proxy binds to. "0.0.0.0" exposes it on the LAN. */
    bindHost: string;
    /** Single access token gating the server when set. Empty = open (loopback dev). */
    accessToken: string;
    /** Opt-in: the desktop KVM view loads through our proxy instead of the Pi
     *  directly (one rendering path with the web client). Off by default. */
    desktopUseProxy: boolean;
    /** Base URL of the pikvm-agent daemon the Agent panel talks to (proxied at
     *  /app/daemon/*). Defaults to http://127.0.0.1:47615; env PIKVM_AGENT_DAEMON
     *  overrides. */
    daemonUrl?: string;
    /** Executable that launches the pikvm-agent daemon (run with `daemon`). The app
     *  spawns + manages it for the Agent panel. Empty → auto-resolve (env
     *  PIKVM_AGENT_DAEMON_CMD → this repo's agent/.venv → a standalone
     *  ~/dev/pikvm-agent checkout → PATH). */
    daemonCmd?: string;
    /** Executable that launches the first-party operator harness. Empty →
     *  PIKVM_HARNESS_CMD, then the daemon executable, then auto-resolution. */
    harnessCmd?: string;
    /** Secret-free BYO-provider harness YAML. Empty → harness.yaml beside settings. */
    harnessConfig?: string;
    /** Working directory for terminal sessions. */
    atlas: AtlasSettings;
}

export interface AtlasSettings {
    /** Path to the working directory (cwd for terminal sessions). */
    vaultPath: string;
}

const DEFAULT_ATLAS: AtlasSettings = {
    vaultPath: resolve(homedir(), "Documents/Atlas/Capgemini"),
};

const DEFAULTS: AppSettings = {
    humanize: 1,
    jiggler: true,
    wpm: 95,
    keyboardLayout: "us",
    bindHost: "127.0.0.1",
    accessToken: "",
    desktopUseProxy: false,
    atlas: DEFAULT_ATLAS,
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
                this.data = {
                    ...DEFAULTS,
                    ...saved,
                    // Deep-merge nested config so new defaults survive partial saves.
                    atlas: { ...DEFAULT_ATLAS, ...(saved.atlas ?? {}) },
                };
            } catch {
                /* keep defaults */
            }
        }
    }

    get(): AppSettings {
        return { ...this.data };
    }

    patch(partial: Partial<AppSettings>): AppSettings {
        const atlas = partial.atlas ? { ...this.data.atlas, ...partial.atlas } : this.data.atlas;
        this.data = { ...this.data, ...partial, atlas };
        try {
            writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch {
            /* best-effort */
        }
        return this.get();
    }
}
