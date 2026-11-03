/**
 * Edge swipe to go back, for the phone's page stack: a touch that starts at the left edge and moves right drags the
 * page after the finger, with the list beneath moving a third as far. Released past a third of the width, or fast
 * enough, the page finishes leaving and `onEnd(true)` goes back; released short of that it springs home and
 * `onEnd(false)` leaves everything as it was.
 *
 * Touch events on the page element only (never the document), so nothing else's touches are read: the KVM picture and
 * the Chat composer are other tabs, and this attaches to nothing there. The move handler is not passive, so a swipe
 * that has locked horizontal can stop the page scrolling under it; a touch that goes vertical first is left alone.
 */

import { type RefObject, useEffect, useRef } from "react";

/** A touch starting within this many px of the page's left edge can begin the swipe. */
export const EDGE_PX = 24;
/** Movement before the direction is decided. */
const SLOP_PX = 8;
/** Past this share of the width, release goes back. */
const COMMIT_SHARE = 1 / 3;
/** Or past this speed (px per ms) with at least `FLICK_MIN_PX` travelled. */
const FLICK_SPEED = 0.5;
const FLICK_MIN_PX = 24;
/** The list underneath travels this share of the page's distance. */
const PARALLAX = 1 / 3;
const SETTLE_MS = 220;

interface Track {
    readonly x0: number;
    readonly y0: number;
    locked: boolean;
    dx: number;
    /** The last few samples, for the release speed. */
    samples: Array<{ x: number; t: number }>;
}

export interface EdgeSwipeOptions {
    /** The page that moves. */
    readonly target: RefObject<HTMLElement | null>;
    /** What shows underneath (the list); moves with it. May be absent until the swipe starts. */
    readonly under: RefObject<HTMLElement | null>;
    readonly enabled: boolean;
    /** The swipe locked horizontal: mount whatever has to be underneath. */
    readonly onStart: () => void;
    /** The swipe ended: `committed` says whether to go back. Whatever `onStart` mounted can go. */
    readonly onEnd: (committed: boolean) => void;
}

const reduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useEdgeSwipeBack(options: EdgeSwipeOptions): void {
    const latest = useRef(options);
    latest.current = options;
    const { enabled } = options;

    useEffect(() => {
        const el = options.target.current;
        if (!enabled || !el) return;
        let track: Track | null = null;
        let settling = false;

        const place = (dx: number): void => {
            const width = el.clientWidth || 1;
            el.style.transform = `translateX(${dx}px)`;
            el.style.boxShadow = "0 0 24px rgb(0 0 0 / 0.25)";
            const below = latest.current.under.current;
            if (below) {
                below.style.transform = `translateX(${(dx - width) * PARALLAX}px)`;
                below.style.transition = "none";
            }
        };
        const clear = (): void => {
            el.style.transform = "";
            el.style.transition = "";
            el.style.boxShadow = "";
            const below = latest.current.under.current;
            if (below) {
                below.style.transform = "";
                below.style.transition = "";
            }
        };
        const finish = (committed: boolean): void => {
            track = null;
            settling = false;
            clear();
            latest.current.onEnd(committed);
        };

        const onStart = (e: TouchEvent): void => {
            if (settling || e.touches.length !== 1) {
                track = null;
                return;
            }
            const touch = e.touches[0];
            if (!touch) return;
            const left = el.getBoundingClientRect().left;
            if (touch.clientX - left > EDGE_PX) {
                track = null;
                return;
            }
            track = { x0: touch.clientX, y0: touch.clientY, locked: false, dx: 0, samples: [{ x: touch.clientX, t: e.timeStamp }] };
        };

        const onMove = (e: TouchEvent): void => {
            const t = track;
            const touch = e.touches[0];
            if (!t || !touch) return;
            const dx = touch.clientX - t.x0;
            const dy = touch.clientY - t.y0;
            if (!t.locked) {
                if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
                // Vertical first, or leftwards: not ours.
                if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) {
                    track = null;
                    return;
                }
                t.locked = true;
                latest.current.onStart();
            }
            e.preventDefault();
            t.dx = Math.max(0, dx);
            t.samples.push({ x: touch.clientX, t: e.timeStamp });
            if (t.samples.length > 6) t.samples.shift();
            place(t.dx);
        };

        const onEnd = (e: TouchEvent): void => {
            const t = track;
            if (!t?.locked) {
                track = null;
                return;
            }
            const width = el.clientWidth || 1;
            const first = t.samples[0];
            const last = t.samples[t.samples.length - 1];
            const speed = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
            const committed = e.type === "touchend" && (t.dx > width * COMMIT_SHARE || (speed > FLICK_SPEED && t.dx > FLICK_MIN_PX));
            settling = true;
            if (reduced()) {
                finish(committed);
                return;
            }
            const to = committed ? width : 0;
            el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.19, 1, 0.22, 1)`;
            const below = latest.current.under.current;
            if (below) {
                below.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.19, 1, 0.22, 1)`;
                below.style.transform = `translateX(${committed ? 0 : -width * PARALLAX}px)`;
            }
            el.style.transform = `translateX(${to}px)`;
            const done = (): void => {
                el.removeEventListener("transitionend", done);
                clearTimeout(fallback);
                if (settling) finish(committed);
            };
            // transitionend does not fire where nothing moved (a swipe released at exactly the end).
            const fallback = setTimeout(done, SETTLE_MS + 60);
            el.addEventListener("transitionend", done);
        };

        el.addEventListener("touchstart", onStart, { passive: true });
        el.addEventListener("touchmove", onMove, { passive: false });
        el.addEventListener("touchend", onEnd);
        el.addEventListener("touchcancel", onEnd);
        return () => {
            el.removeEventListener("touchstart", onStart);
            el.removeEventListener("touchmove", onMove);
            el.removeEventListener("touchend", onEnd);
            el.removeEventListener("touchcancel", onEnd);
            clear();
        };
    }, [enabled, options.target]);
}
