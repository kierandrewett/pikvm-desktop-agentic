/**
 * Motion helpers for animations driven from JavaScript (Web Animations API, timers). CSS durations
 * scale through --motion-scale already; use these so JS-driven motion follows ui.motion.* too.
 */

import { isInstant } from "./instant";

function readVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Duration scaled by the user's speed setting (0 means no animation). */
export function motionMs(ms: number): number {
    // A keyboard shortcut shows its result at once (lib/instant.ts).
    if (isInstant()) return 0;
    const scale = Number.parseFloat(readVar("--motion-scale"));
    return ms * (Number.isFinite(scale) ? scale : 1);
}

/** Current curve for a role, as a CSS easing string usable in element.animate(). */
export function motionEase(role: "basic" | "standard" | "enter" | "exit" = "standard"): string {
    return readVar(`--ease-${role}`) || "ease";
}

export const CURVES: Record<string, { label: string; basic: string; standard: string; enter: string; exit: string }> = {
    reference: {
        label: "Default",
        basic: "ease",
        standard: "cubic-bezier(0.4, 0, 0.2, 1)",
        enter: "cubic-bezier(0.19, 1, 0.22, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
    },
    smooth: {
        label: "Smooth",
        basic: "cubic-bezier(0.45, 0, 0.2, 1)",
        standard: "cubic-bezier(0.45, 0, 0.2, 1)",
        enter: "cubic-bezier(0.32, 0.72, 0, 1)",
        exit: "cubic-bezier(0.55, 0, 0.75, 0.2)",
    },
    snappy: {
        label: "Snappy",
        basic: "cubic-bezier(0.2, 0, 0, 1)",
        standard: "cubic-bezier(0.2, 0, 0, 1)",
        enter: "cubic-bezier(0.05, 0.7, 0.1, 1)",
        exit: "cubic-bezier(0.3, 0, 0.8, 0.15)",
    },
    spring: {
        label: "Springy",
        basic: "cubic-bezier(0.34, 1.3, 0.64, 1)",
        standard: "cubic-bezier(0.34, 1.3, 0.64, 1)",
        enter: "linear(0, 0.036 2%, 0.141 4.4%, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.077 20.4%, 1.149 24.3%, 1.163 27%, 1.129 32.8%, 1.051 39.6%, 0.991 47.1%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
    },
    linear: { label: "Linear", basic: "linear", standard: "linear", enter: "linear", exit: "linear" },
};
