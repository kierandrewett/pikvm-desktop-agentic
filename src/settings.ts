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
}

const DEFAULTS: AppSettings = {
    model: "gpt-5.5",
    policy: "risky-only",
    humanize: 1,
    pauseOnPresence: true,
    wpm: 95,
    sidebarWidth: 380,
};

export class SettingsStore {
    private data: AppSettings;

    constructor(private readonly path: string) {
        this.data = { ...DEFAULTS };
        if (existsSync(path)) {
            try {
                this.data = { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf-8")) };
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
