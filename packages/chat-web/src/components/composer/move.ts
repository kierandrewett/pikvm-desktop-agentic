/**
 * The composer as a shared element across layouts. It travels for home (centred) -> conversation, and both ways
 * when temporary mode is toggled on the home page. Every other change of layout (a conversation back to the
 * centred home, one conversation to another, a side panel opening or closing) is instant.
 *
 * - Route changes: the router's `defaultViewTransition` (main.tsx) runs a view transition only when the
 *   composer goes from the home slot to the thread slot (`composerViewTransition`), typed "composer-move".
 * - State changes (temporary mode): `moveComposer(update)` wraps the update in a view transition.
 * - The composer root carries `view-transition-name: composer`; composer.css tunes the morph with the motion
 *   tokens and keeps the rest of the page to a quick cross-fade.
 * - Without the View Transitions API (or without transition types, for route changes) the composer falls back
 *   to FLIP: the outgoing instance leaves its rect in `handOff`, the incoming one animates from it.
 * - Temporary mode without view transitions: the same FLIP fallback runs for the toggle, ON and OFF.
 * - Reduced motion: no transition at all.
 * - A send that navigates (`skipComposerMove`): no transition. The view transition freezes the page for MOVE_MS
 *   and swallows the first click, so the Stop button would not answer for about 420 ms after Send.
 */
import { flushSync } from "react-dom";
import { motionEase, motionMs } from "../../lib/motion";
import { reducedMotion } from "../model-picker/motion";

type Location = { pathname: string } | undefined;
export type ComposerSlot = "home" | "thread" | null;

/** Set while a view transition is moving the composer, so the FLIP fallback stays out of its way. */
let transitionUntil = 0;
const MOVE_MS = 420;
/** True while a state change (temporary mode) renders without view transitions, so FLIP may animate any slot change. */
let stateMoving = false;

/** Until this time a route change does not move the composer (set by a send that navigates). */
let skipUntil = 0;
const SKIP_MS = 2000;

/** Call just before a send navigates to the new chat. The composer then appears in place at once. */
export function skipComposerMove(): void {
    skipUntil = performance.now() + SKIP_MS;
}

const skipping = () => performance.now() < skipUntil;

export const viewTransitionMoving = () => performance.now() < transitionUntil;

function canTransition(): boolean {
    return (
        typeof document !== "undefined" &&
        typeof document.startViewTransition === "function" &&
        !reducedMotion() &&
        motionMs(MOVE_MS) > 0
    );
}

function slot(loc: Location): ComposerSlot {
    if (!loc) return null;
    if (loc.pathname === "/") return "home";
    if (loc.pathname.startsWith("/c/")) return "thread";
    return null;
}

/** Run a state change that moves the composer (for example temporary mode) inside a view transition. */
export function moveComposer(update: () => void): void {
    if (!canTransition()) {
        // No View Transitions API: render synchronously so the FLIP fallback in arriveFrom runs for this toggle,
        // in both directions. Reduced motion (or a zero motion scale) skips it.
        if (typeof document === "undefined" || reducedMotion() || motionMs(MOVE_MS) === 0) return update();
        stateMoving = true;
        try {
            flushSync(update);
        } finally {
            stateMoving = false;
        }
        return;
    }
    transitionUntil = performance.now() + motionMs(MOVE_MS) * 3;
    document.startViewTransition(() => flushSync(update));
}

/**
 * Router option: transition only when the composer changes slot. Undefined (no router transitions at all)
 * where transition types are not supported, because the router would otherwise transition every navigation;
 * the FLIP fallback covers those browsers.
 */
export function composerViewTransition():
    { types: (info: { fromLocation?: Location; toLocation: Location }) => string[] | false } | undefined {
    if (typeof document === "undefined" || typeof document.startViewTransition !== "function") return undefined;
    if (!CSS.supports?.("selector(:active-view-transition-type(a))")) return undefined;
    return {
        types: ({ fromLocation, toLocation }) => {
            const from = slot(fromLocation);
            const to = slot(toLocation);
            if (from !== "home" || to !== "thread" || skipping() || reducedMotion() || motionMs(MOVE_MS) === 0)
                return false;
            transitionUntil = performance.now() + motionMs(MOVE_MS) * 3;
            return ["composer-move"];
        },
    };
}

/** The composer slot for the current address, read when a composer mounts. */
export function currentSlot(): ComposerSlot {
    return typeof location === "undefined" ? null : slot(location);
}

// FLIP fallback: the last composer's rect and slot, left on unmount for the next one to animate from.
let handOff: { rect: DOMRect; at: number; from: ComposerSlot } | null = null;

export function leaveRect(el: HTMLElement, from: ComposerSlot): void {
    handOff = { rect: el.getBoundingClientRect(), at: performance.now(), from };
}

/**
 * Animate a freshly mounted composer from where the previous one stood (only when no view transition ran), and
 * only for home -> thread. Switching conversations remounts the composer too; it must not slide sideways when a
 * side panel closes.
 */
export function arriveFrom(el: HTMLElement, to: ComposerSlot): void {
    const h = handOff;
    handOff = null;
    if (!h || skipping() || (!stateMoving && (h.from !== "home" || to !== "thread"))) return;
    if (performance.now() - h.at > 800 || viewTransitionMoving() || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    const dx = h.rect.left - r.left;
    const dy = h.rect.top - r.top;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    const duration = motionMs(MOVE_MS);
    if (duration === 0) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration,
        easing: motionEase(),
    });
}
