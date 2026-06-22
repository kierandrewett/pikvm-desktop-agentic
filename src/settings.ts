/**
 * Persisted app settings (model, review policy, humanize intensity, presence
 * behaviour, sidebar width). Stored as JSON in the app's userData and applied
 * on startup so preferences survive restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ReviewPolicy } from "./reviewer";

export interface AppSettings {
    model: string;
    policy: ReviewPolicy;
    /** Typing humanity 0..1 (0 = no typos, full cadence; 1 = full human). */
    humanize: number;
    /** Whether the agent auto-pauses when the PiKVM mic/audio is active. */
    pauseOnPresence: boolean;
    /** Baseline typing WPM the random persona centers on. */
    wpm: number;
    /** Target keyboard layout (the agent sends physical key codes; this sets glyphs). */
    keyboardLayout: "us" | "uk";
    sidebarWidth: number;
    goal?: string;
    /** Host the control server + proxy binds to. "0.0.0.0" exposes it on the LAN. */
    bindHost: string;
    /** Single access token gating the server when set. Empty = open (loopback dev). */
    accessToken: string;
    /** Opt-in: the desktop KVM view loads through our proxy instead of the Pi
     *  directly (one rendering path with the web client). Off by default. */
    desktopUseProxy: boolean;
    /** Ambient background screen/meeting monitor. */
    ambient: AmbientSettings;
    /** Atlas markdown memory vault (via the Atlas MCP server). */
    atlas: AtlasSettings;
    /** Dynamic per-turn model switching (reasoning vs cheap tool-calling). */
    modelRouting: ModelRoutingSettings;
}

export interface ModelRoutingSettings {
    /** Route each turn dynamically. When off, every turn uses `reasoningModel`. */
    enabled: boolean;
    /** Capable model for thinking/reasoning/problem-solving turns. */
    reasoningModel: string;
    /**
     * Cheap/fast model for routine, mechanical tool-driving turns.
     * NB: must be reachable through the active provider. Under the ChatGPT-
     * subscription auth (`openai-codex`) Kimi is NOT available — the cheapest
     * fast+vision model there is gpt-5.4-mini.
     */
    fastModel: string;
}

const DEFAULT_MODEL_ROUTING: ModelRoutingSettings = {
    enabled: true,
    reasoningModel: "gpt-5.5",
    fastModel: "gpt-5.4-mini",
};

export interface AtlasSettings {
    /** Use the Atlas vault for memory (markdown via the Atlas MCP server). */
    enabled: boolean;
    /** Path to the built `atlas` binary. */
    binPath: string;
    /** Path to the vault directory. */
    vaultPath: string;
}

const DEFAULT_ATLAS: AtlasSettings = {
    enabled: true,
    binPath: resolve(homedir(), "dev/atlas-2/atlas-app-v16/target/release/atlas"),
    vaultPath: resolve(homedir(), "Documents/Atlas/Capgemini"),
};

export interface AmbientSettings {
    /** Master switch for the background monitor. */
    enabled: boolean;
    /** Capture/diff cadence in ms. */
    intervalMs: number;
    /** Cheap Pi model used to triage a detected change. */
    triageModel: string;
    /** Stronger model used when intelligence matters (meeting brief, etc). */
    smartModel: string;
    /** Send a push (ntfy) for important events. */
    notify: boolean;
    /** Run the meeting assistant (brief + suggestions) when a meeting is detected. */
    meetingAssist: boolean;
    /** Transcribe meeting audio locally (whisper.cpp) while a meeting is active. */
    transcribe: boolean;
    /** Only run the monitor within these hours (24h "HH:MM"); supports overnight windows. */
    activeHours: { enabled: boolean; start: string; end: string };
    ntfy: { baseUrl: string; topic: string; activeCheckUrl: string };
}

const DEFAULT_AMBIENT: AmbientSettings = {
    enabled: false,
    intervalMs: 4000,
    // Cheap vision model for change triage. gpt-5.4-mini is the available "mini"
    // (the Codex sub exposes gpt-5.3-codex-spark / gpt-5.4 / gpt-5.4-mini / gpt-5.5).
    triageModel: "gpt-5.4-mini",
    smartModel: "gpt-5.5",
    notify: true,
    meetingAssist: true,
    transcribe: false,
    activeHours: { enabled: false, start: "09:00", end: "18:00" },
    ntfy: {
        baseUrl: "https://ntfy.drewett.dev",
        topic: "claude",
        activeCheckUrl: "https://is-kieran.drewett.dev/active?format=text",
    },
};

const DEFAULTS: AppSettings = {
    model: "gpt-5.5",
    policy: "risky-only",
    humanize: 1,
    pauseOnPresence: true,
    wpm: 95,
    keyboardLayout: "us",
    sidebarWidth: 440,
    bindHost: "127.0.0.1",
    accessToken: "",
    desktopUseProxy: false,
    ambient: DEFAULT_AMBIENT,
    atlas: DEFAULT_ATLAS,
    modelRouting: DEFAULT_MODEL_ROUTING,
};

export class SettingsStore {
    private data: AppSettings;

    constructor(private readonly path: string) {
        this.data = { ...DEFAULTS };
        if (existsSync(path)) {
            try {
                const saved = JSON.parse(readFileSync(path, "utf-8"));
                this.data = {
                    ...DEFAULTS,
                    ...saved,
                    // Deep-merge nested config so new defaults survive partial saves.
                    ambient: {
                        ...DEFAULT_AMBIENT,
                        ...(saved.ambient ?? {}),
                        ntfy: { ...DEFAULT_AMBIENT.ntfy, ...(saved.ambient?.ntfy ?? {}) },
                        activeHours: { ...DEFAULT_AMBIENT.activeHours, ...(saved.ambient?.activeHours ?? {}) },
                    },
                    atlas: { ...DEFAULT_ATLAS, ...(saved.atlas ?? {}) },
                    modelRouting: { ...DEFAULT_MODEL_ROUTING, ...(saved.modelRouting ?? {}) },
                };
                // Migrate the never-valid early default model id off saved configs.
                if (this.data.ambient.triageModel === "gpt-5.5-mini") {
                    this.data.ambient.triageModel = DEFAULT_AMBIENT.triageModel;
                }
            } catch {
                /* keep defaults */
            }
        }
    }

    get(): AppSettings {
        return { ...this.data };
    }

    patch(partial: Partial<AppSettings>): AppSettings {
        const ambient = partial.ambient
            ? {
                  ...this.data.ambient,
                  ...partial.ambient,
                  ntfy: { ...this.data.ambient.ntfy, ...(partial.ambient.ntfy ?? {}) },
                  activeHours: { ...this.data.ambient.activeHours, ...(partial.ambient.activeHours ?? {}) },
              }
            : this.data.ambient;
        const atlas = partial.atlas ? { ...this.data.atlas, ...partial.atlas } : this.data.atlas;
        const modelRouting = partial.modelRouting ? { ...this.data.modelRouting, ...partial.modelRouting } : this.data.modelRouting;
        this.data = { ...this.data, ...partial, ambient, atlas, modelRouting };
        try {
            writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch {
            /* best-effort */
        }
        return this.get();
    }
}
