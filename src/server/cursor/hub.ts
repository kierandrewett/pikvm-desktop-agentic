import { NORM_MAX, NORM_MIN, NORM_SPAN, systemClock, type CancelTimer, type Clock } from "@pikvm/kvm-engine";
import type { CursorUpdate } from "@pikvm/contracts/api";

/**
 * One cursor for every client.
 *
 * The host is the one place that sees every mouse event: each page's input socket passes through the kvmd proxy,
 * and the agent's tools report where they put the pointer. So it keeps the single answer to "where is the target's
 * pointer", in kvmd's own units, and tells every client when it changes. A client draws what it is told and never
 * asks another client.
 *
 * What it knows, and when:
 *   - An absolute move says where the pointer is, exactly. (Not while the Pi is in relative mode: kvmd drops it.)
 *   - A relative move moves the last known position by the delta, clamped to the screen. The delta is in target
 *     pixels, so it is turned into a fraction with the screen's width and height. The target's own pointer
 *     acceleration is not known, so this is an estimate that the next absolute move corrects. With no position yet
 *     (nothing absolute since the host started) a relative move says nothing: the position stays unknown and
 *     nobody is told, so a client keeps the cursor it has until the first absolute move.
 *   - The agent's tools say where they left the pointer in either mode (on a relative target they sweep into the
 *     corner first, which pins it), so that is a known position.
 *   - A change of the screen's resolution keeps an absolute position (it is a fraction of the screen) and, on a
 *     relative target, keeps the pixel the pointer was on, which is what the target's operating system does.
 *
 * Updates are told at most once per `frameMs`: the first at once, a burst after it as one trailing update with the
 * newest position, so a fast mouse costs a client one message per frame, not one per event.
 */

export type MouseMode = "absolute" | "relative" | "unknown";

export interface Resolution {
    readonly width: number;
    readonly height: number;
}

/** What a client sees of the screen when the Pi has not said: only the relative conversion uses it. */
const ASSUMED: Resolution = { width: 1920, height: 1080 };

export interface CursorHubOptions {
    /** The Pi's mouse mode now. */
    mode(): MouseMode;
    /** The target's screen resolution now, if known. */
    resolution(): Resolution | undefined;
    clock?: Clock;
    /** The least gap between two updates; a display frame by default. */
    frameMs?: number;
}

export interface CursorHub {
    /** `source` moved the pointer to this absolute spot (kvmd units). */
    absolute(source: string, x: number, y: number): void;
    /** `source` moved the pointer by this many target pixels. */
    relative(source: string, dx: number, dy: number): void;
    /** `source` put the pointer here and knows it, whatever the mouse mode (the agent). */
    place(source: string, x: number, y: number): void;
    /** The resolution may have changed: re-read it, and tell everyone if the position moved because of it. */
    noteResolution(): void;
    /** The newest position, or null while it is not known. */
    current(): CursorUpdate | null;
    subscribe(listener: (update: CursorUpdate) => void): () => void;
    dispose(): void;
}

const clamp = (n: number): number => Math.max(NORM_MIN, Math.min(NORM_MAX, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Pixel on a `span`-pixel axis to kvmd units, and back: the same mapping the pointer's own conversion uses. */
const toPixel = (norm: number, span: number): number => ((norm - NORM_MIN) / NORM_SPAN) * Math.max(1, span - 1);
const toNorm = (px: number, span: number): number => (px / Math.max(1, span - 1)) * NORM_SPAN + NORM_MIN;

export function createCursorHub(options: CursorHubOptions): CursorHub {
    const clock = options.clock ?? systemClock;
    const frameMs = options.frameMs ?? 16;
    const listeners = new Set<(update: CursorUpdate) => void>();

    // Kept as floats so a slow relative drag adds up; told as whole numbers.
    let at: { x: number; y: number } | null = null;
    let source = "";
    let seq = 0;
    let screen: Resolution | undefined;

    let lastTold = Number.NEGATIVE_INFINITY;
    let waiting: CancelTimer | null = null;
    let owed = false;

    const snapshot = (): CursorUpdate | null => (at ? { x: Math.round(at.x), y: Math.round(at.y), source, seq } : null);

    const tell = (): void => {
        owed = false;
        lastTold = clock.now();
        const update = snapshot();
        if (!update) return;
        // Copied first: a listener may unsubscribe while it is told.
        for (const listener of [...listeners]) listener(update);
    };

    const schedule = (): void => {
        owed = true;
        if (waiting) return;
        const wait = lastTold + frameMs - clock.now();
        if (wait <= 0) {
            tell();
            return;
        }
        waiting = clock.setTimeout(() => {
            waiting = null;
            if (owed) tell();
        }, wait);
    };

    /** The screen as the Pi last said it. A change moves a relative position (see above); true when it did. */
    const syncScreen = (): boolean => {
        const now = options.resolution();
        if (!now || !finite(now.width) || !finite(now.height) || now.width < 1 || now.height < 1) return false;
        const before = screen;
        screen = now;
        if (!before || !at || (before.width === now.width && before.height === now.height)) return false;
        if (options.mode() !== "relative") return false;
        const next = {
            x: clamp(toNorm(toPixel(at.x, before.width), now.width)),
            y: clamp(toNorm(toPixel(at.y, before.height), now.height)),
        };
        return set("host", next.x, next.y);
    };

    /** Take a position; true when it differs (in the whole units that are told) from the one held. */
    const set = (by: string, x: number, y: number): boolean => {
        const cx = clamp(x);
        const cy = clamp(y);
        const same = at !== null && Math.round(at.x) === Math.round(cx) && Math.round(at.y) === Math.round(cy);
        at = { x: cx, y: cy };
        if (same) return false;
        source = by;
        seq += 1;
        schedule();
        return true;
    };

    return {
        absolute(by, x, y) {
            if (!finite(x) || !finite(y)) return;
            // A relative Pi drops absolute moves: nothing moved.
            if (options.mode() === "relative") return;
            syncScreen();
            set(by, x, y);
        },
        place(by, x, y) {
            if (!finite(x) || !finite(y)) return;
            syncScreen();
            set(by, x, y);
        },
        relative(by, dx, dy) {
            if (!finite(dx) || !finite(dy) || (dx === 0 && dy === 0)) return;
            // An absolute Pi drops relative moves, and an unknown one cannot be told apart from it.
            if (options.mode() !== "relative") return;
            syncScreen();
            if (!at) return;
            const size = screen ?? ASSUMED;
            set(by, at.x + (dx / Math.max(1, size.width - 1)) * NORM_SPAN, at.y + (dy / Math.max(1, size.height - 1)) * NORM_SPAN);
        },
        noteResolution() {
            syncScreen();
        },
        current() {
            syncScreen();
            return snapshot();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose() {
            waiting?.();
            waiting = null;
            listeners.clear();
        },
    };
}
