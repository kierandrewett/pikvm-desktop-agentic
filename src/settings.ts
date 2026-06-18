/**
 * Persisted app settings (model, review policy, humanize intensity, presence
 * behaviour, sidebar width). Stored as JSON in the app's userData and applied
 * on startup so preferences survive restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
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
    sidebarWidth: number;
    goal?: string;
    /** Ambient background screen/meeting monitor. */
    ambient: AmbientSettings;
}

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
    ntfy: { baseUrl: string; topic: string; activeCheckUrl: string };
}

const DEFAULT_AMBIENT: AmbientSettings = {
    enabled: false,
    intervalMs: 4000,
    triageModel: "gpt-5.5-mini",
    smartModel: "gpt-5.5",
    notify: true,
    meetingAssist: true,
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
    sidebarWidth: 440,
    ambient: DEFAULT_AMBIENT,
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
                    },
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
        const ambient = partial.ambient
            ? { ...this.data.ambient, ...partial.ambient, ntfy: { ...this.data.ambient.ntfy, ...(partial.ambient.ntfy ?? {}) } }
            : this.data.ambient;
        this.data = { ...this.data, ...partial, ambient };
        try {
            writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch {
            /* best-effort */
        }
        return this.get();
    }
}
