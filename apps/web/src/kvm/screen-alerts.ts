/**
 * Background screen-change alerts (the desktop app and desktop browsers). While the window sits
 * behind something else the picture is still watched: when a big enough part of it changes (a
 * dialog opens, the target reboots, a long install finishes) the user is told: the taskbar entry
 * pulses in the desktop app, the tab's title, the app badge and a notification do the same in a
 * browser (attention.ts). The detection is the engine's (screen-activity.ts, over the luminance
 * grid the blank sampler already reads back); this is the part that decides whether anyone is
 * watching and what to do about it.
 */

import { INITIAL_SCREEN_ACTIVITY, noteScreenSample, type Clock, type ScreenActivityState } from "@pikvm/kvm-engine";
import { isDesktopApp } from "../host/desktop";
import type { Attention } from "./attention";

export const SCREEN_ALERTS_KEY = "pikvm-console-screen-alerts";

/**
 * The desktop app has always had alerts on unless turned off. A browser starts with them off: they
 * keep the picture streaming to a tab nobody is looking at, and they ask for notifications, which a
 * page should only do when the user has said yes.
 */
export const readScreenAlerts = (): "on" | "off" => {
    const fallback = isDesktopApp() ? "on" : "off";
    try {
        const stored = localStorage.getItem(SCREEN_ALERTS_KEY);
        return stored === "on" || stored === "off" ? stored : fallback;
    } catch {
        return fallback;
    }
};

/**
 * Watch only while the window is in the BACKGROUND (a focused one is already being looked at), and
 * only where the page keeps running there: a phone suspends it, so `available` is false and nothing
 * is promised.
 */
export function watchingForChange(available: boolean, enabled: boolean, background: boolean): boolean {
    return available && enabled && background;
}

export interface ScreenAlerts {
    /** One luminance grid from the sampler. */
    sample(lum: Float32Array): void;
}

export function createScreenAlerts(options: {
    readonly clock: Clock;
    readonly attention: Attention;
    readonly watching: () => boolean;
}): ScreenAlerts {
    let state: ScreenActivityState = INITIAL_SCREEN_ACTIVITY;
    return {
        sample(lum) {
            const result = noteScreenSample(state, lum, options.watching(), options.clock.now());
            state = result.state;
            if (result.alert) options.attention.requestAttention();
        },
    };
}
