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
    /**
     * Autonomy dial (0–5). 0 = maximum caution (prompt for almost everything);
     * 5 = maximum autonomy (prompt only for dangerous / outward-facing actions).
     * 3 is the balanced default. Tunes how eagerly inherently-safe commands run
     * without an approval prompt — see the reviewer's command classifier.
     */
    autonomy: number;
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

/**
 * Per-role model selection. Each model is named as a `provider/model` spec (e.g.
 * `codex/gpt-5.5`, `moonshotai/kimi-k2.6`), so different roles can run on
 * different providers. Bare model ids saved by older builds (`gpt-5.5`) are
 * migrated to `codex/<id>` on load, preserving today's behaviour.
 */
export interface ModelRoutingSettings {
    /** Route each turn dynamically. When off, every turn uses `reasoningModel`. */
    enabled: boolean;
    /** Capable model for thinking/reasoning/problem-solving turns (`provider/model`). */
    reasoningModel: string;
    /**
     * Cheap/fast model for routine, mechanical tool-driving turns (`provider/model`).
     * MUST be vision-capable (the loop sends screenshots) — a text-only choice is
     * rejected at runtime and the reasoning model is used instead.
     */
    fastModel: string;
    /** Model sub-agents use for focused side-tasks (`provider/model`). */
    subagentModel: string;
}

const DEFAULT_MODEL_ROUTING: ModelRoutingSettings = {
    enabled: true,
    reasoningModel: "codex/gpt-5.5",
    fastModel: "codex/gpt-5.4-mini",
    subagentModel: "codex/gpt-5.5",
};

/**
 * Migrate a model field to the `provider/model` form. A value already containing
 * a "/" is left as-is; a bare id (legacy) is assumed to be a codex model and
 * prefixed with `codex/`, preserving the pre-multi-provider behaviour exactly.
 */
function migrateModelSpec(value: unknown, fallback: string): string {
    if (typeof value !== "string" || !value.trim()) return fallback;
    const v = value.trim();
    return v.includes("/") ? v : `codex/${v}`;
}

/** Apply spec migration to a (possibly legacy) saved modelRouting object. */
function migrateModelRouting(saved: Partial<ModelRoutingSettings> | undefined): ModelRoutingSettings {
    return {
        enabled: typeof saved?.enabled === "boolean" ? saved.enabled : DEFAULT_MODEL_ROUTING.enabled,
        reasoningModel: migrateModelSpec(saved?.reasoningModel, DEFAULT_MODEL_ROUTING.reasoningModel),
        fastModel: migrateModelSpec(saved?.fastModel, DEFAULT_MODEL_ROUTING.fastModel),
        subagentModel: migrateModelSpec(saved?.subagentModel, DEFAULT_MODEL_ROUTING.subagentModel),
    };
}

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
    autonomy: 3,
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
                    // Migrate legacy bare model ids (`gpt-5.5`) to `codex/gpt-5.5`.
                    modelRouting: migrateModelRouting(saved.modelRouting),
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
