/**
 * Enter animation for the model picker and effort menus (ui-spec 3.5 `model-picker-dropdown-content-enter`):
 * opacity 0 -> 1 and scale .98 -> 1 over 320ms `--ease-enter-snappy`, 30ms delay. Done with the Web Animations
 * API so no shared keyframes are needed. Skipped under reduced motion (OS setting or `ui.reducedMotion`).
 */
import { isInstant } from "../../lib/instant";

export const EASE_ENTER_SNAPPY = "cubic-bezier(0.23, 1, 0.32, 1)";

export function reducedMotion(): boolean {
    // A keyboard shortcut counts as reduced motion for its own result (lib/instant.ts).
    if (isInstant()) return true;
    const attr = document.documentElement.dataset.reducedMotion;
    if (attr === "on" || attr === "true") return true;
    if (attr === "off" || attr === "false") return false;
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function animateEnter(el: HTMLElement | null): void {
    if (!el || reducedMotion()) return;
    el.animate(
        [
            { opacity: 0, transform: "scale(0.98)" },
            { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 320, delay: 30, easing: EASE_ENTER_SNAPPY, fill: "backwards" },
    );
}
