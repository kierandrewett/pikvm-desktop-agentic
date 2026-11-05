/**
 * How the picture-in-picture window moves when it is let go of: it keeps the speed of the throw, slows down, and bounces
 * off the edges of the area it lives in. Pure: the component feeds it the time since the last step.
 */

export interface Body {
    /** The top-left corner, in pixels from the top-left of the area. */
    readonly x: number;
    readonly y: number;
    /** Pixels per second. */
    readonly vx: number;
    readonly vy: number;
}

export interface Area {
    readonly width: number;
    readonly height: number;
    /** The body's own size. */
    readonly w: number;
    readonly h: number;
    /** Kept clear on every side: the safe area and a margin. */
    readonly inset: number;
}

/** Speed lost per second, as a rate: after one second 1/e of the speed is left. */
const FRICTION = 2.6;
/** A bounce keeps this much of the speed. */
const RESTITUTION = 0.62;
/** Below this speed (pixels per second) the body is at rest. */
export const REST_SPEED = 14;
/** A throw is never faster than this, so a flick cannot make it unreadable. */
const MAX_SPEED = 4200;

export const clamp = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, n));

/** Where the body may be: its top-left corner between these. */
function limits(area: Area): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
} {
    return {
        minX: area.inset,
        maxX: Math.max(area.inset, area.width - area.w - area.inset),
        minY: area.inset,
        maxY: Math.max(area.inset, area.height - area.h - area.inset),
    };
}

/** The position kept inside the area (after a resize, or while it is dragged). */
export function keepInside(
    x: number,
    y: number,
    area: Area,
): { x: number; y: number } {
    const l = limits(area);
    return { x: clamp(x, l.minX, l.maxX), y: clamp(y, l.minY, l.maxY) };
}

/** The release velocity, capped. */
export function throwOf(vx: number, vy: number): { vx: number; vy: number } {
    const speed = Math.hypot(vx, vy);
    if (speed <= MAX_SPEED) return { vx, vy };
    const k = MAX_SPEED / speed;
    return { vx: vx * k, vy: vy * k };
}

export const atRest = (body: Body): boolean =>
    Math.hypot(body.vx, body.vy) < REST_SPEED;

/** One step of `dt` seconds. A long step is split so a fast body cannot pass through an edge. */
export function step(body: Body, dt: number, area: Area): Body {
    const l = limits(area);
    let { x, y, vx, vy } = body;
    let left = Math.min(dt, 0.25);
    const slice = 1 / 120;
    while (left > 0) {
        const d = Math.min(slice, left);
        left -= d;
        const decay = Math.exp(-FRICTION * d);
        vx *= decay;
        vy *= decay;
        x += vx * d;
        y += vy * d;
        if (x < l.minX) {
            x = l.minX;
            vx = Math.abs(vx) * RESTITUTION;
        } else if (x > l.maxX) {
            x = l.maxX;
            vx = -Math.abs(vx) * RESTITUTION;
        }
        if (y < l.minY) {
            y = l.minY;
            vy = Math.abs(vy) * RESTITUTION;
        } else if (y > l.maxY) {
            y = l.maxY;
            vy = -Math.abs(vy) * RESTITUTION;
        }
    }
    return atRest({ x, y, vx, vy }) ? { x, y, vx: 0, vy: 0 } : { x, y, vx, vy };
}

/** A pointer sample while the window is dragged. */
export interface Sample {
    readonly x: number;
    readonly y: number;
    /** Milliseconds. */
    readonly at: number;
}

/** How far back the throw's speed is read from: older movement is not part of the flick. */
const WINDOW_MS = 90;

/** The velocity of a drag from its last samples, in pixels per second. Nothing recent means the pointer was still. */
export function velocityOf(
    samples: readonly Sample[],
    now: number,
): { vx: number; vy: number } {
    const recent = samples.filter((s) => now - s.at <= WINDOW_MS);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || last.at - first.at < 8) return { vx: 0, vy: 0 };
    const seconds = (last.at - first.at) / 1000;
    return throwOf((last.x - first.x) / seconds, (last.y - first.y) / seconds);
}
