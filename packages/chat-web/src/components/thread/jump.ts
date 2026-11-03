/**
 * Jump to the previous or next of your messages in the thread (Mod+Alt+ArrowUp / Mod+Alt+ArrowDown, listed in
 * Settings > Keyboard shortcuts). The targets come from the turn list, not a DOM scan: each turn that starts
 * with a user message renders as `[data-turn-key="<key>"]`, and a binary search over their offsets finds the
 * neighbour of the current scroll position in log n layout reads, so a 5,000-turn chat costs the same.
 *
 * Scrolling only: focus stays where it is (usually the composer), so typing is never interrupted.
 */
import { motionMs } from "../../lib/motion";
import type { Turn } from "./turns";

/** No smooth scrolling when motion is off (ui.motion speed 0) or the system asks for less motion. */
const instant = () => motionMs(1) === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keys of the turns that start with a user message, in thread order. */
export function userTurnKeys(turns: readonly (Turn | undefined)[]): string[] {
    const out: string[] = [];
    for (const t of turns) if (t?.user) out.push(t.key);
    return out;
}

/** Offset of `el` from the top of the scroller's content. */
const topIn = (scroller: HTMLElement, el: HTMLElement) =>
    el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

/**
 * Scroll to the user message before (`dir` -1) or after (`dir` 1) the top of the visible area. Returns false
 * when there is none in that direction.
 */
export function jumpToUserMessage(scroller: HTMLElement, keys: readonly string[], dir: -1 | 1): boolean {
    const header = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const view = scroller.scrollTop + header;
    const elementAt = (i: number) =>
        scroller.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(keys[i]!)}"]`) ?? undefined;
    // First index whose top is below the view top (plus a little slack, so the current target is skipped).
    let low = 0;
    let high = keys.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        const el = elementAt(mid);
        if (el && topIn(scroller, el) <= view + 4) low = mid + 1;
        else high = mid;
    }
    // `low` is the first message below the view top; the one before it is at or above it.
    let i = dir === 1 ? low : low - 1;
    const el0 = i >= 0 ? elementAt(i) : undefined;
    if (dir === -1 && el0 && Math.abs(topIn(scroller, el0) - view) <= 4) i -= 1;
    const target = i >= 0 && i < keys.length ? elementAt(i) : undefined;
    if (!target) return false;
    target.scrollIntoView({ block: "start", behavior: instant() ? "auto" : "smooth" });
    return true;
}
