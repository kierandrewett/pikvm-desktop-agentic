/**
 * Background screen-change alerts (desktop app only). While the window sits behind something else
 * the picture is still watched: when a big enough part of it changes (a dialog opens, the target
 * reboots, a long install finishes) the taskbar entry is pulsed. The detection is the engine's
 * (screen-activity.ts, over the luminance grid the blank sampler already reads back); this is the
 * part that decides whether anyone is watching and what to do about it.
 */

import { INITIAL_SCREEN_ACTIVITY, noteScreenSample, type Clock, type ScreenActivityState } from "@pikvm/kvm-engine";
import type { DesktopBridge } from "@pikvm/contracts/desktop";

export const SCREEN_ALERTS_KEY = "pikvm-console-screen-alerts";

/** Alerts are on unless the user turned them off. */
export const readScreenAlerts = (): "on" | "off" => {
    try {
        return localStorage.getItem(SCREEN_ALERTS_KEY) === "off" ? "off" : "on";
    } catch {
        return "on";
    }
};

/** Watch only while the desktop window is in the BACKGROUND: a focused window is already being looked at, and the web has no taskbar to pulse. */
export function watchingForChange(bridge: Pick<DesktopBridge, "requestAttention"> | undefined, enabled: boolean, windowFocused: boolean): boolean {
    return !!bridge && enabled && !windowFocused;
}

export interface ScreenAlerts {
    /** One luminance grid from the sampler. */
    sample(lum: Float32Array): void;
}

export function createScreenAlerts(options: {
    readonly clock: Clock;
    readonly bridge: Pick<DesktopBridge, "requestAttention"> | undefined;
    readonly watching: () => boolean;
}): ScreenAlerts {
    let state: ScreenActivityState = INITIAL_SCREEN_ACTIVITY;
    return {
        sample(lum) {
            const result = noteScreenSample(state, lum, options.watching(), options.clock.now());
            state = result.state;
            if (result.alert) options.bridge?.requestAttention();
        },
    };
}
