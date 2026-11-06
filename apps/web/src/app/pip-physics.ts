/**
 * How the picture-in-picture window moves when it is let go of: it picks the corner of the area that its position and throw
 * point at, and a spring pulls it there. It never bounces off the sides. Pure: the component feeds it the time since the last step.
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

/** Spring stiffness and damping (damping ratio about 0.8): a quick pull to the corner with one small overshoot. */
const STIFFNESS = 260;
const DAMPING = 25.8;
/** How far ahead (seconds) the throw is projected to choose the corner: a flick picks the corner it points at. */
const LOOK_AHEAD = 0.22;
/** Within this distance (pixels) and this speed (pixels per second) of its corner the body is at rest. */
const REST_DISTANCE = 0.4;
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

/** The corner (top-left position of the body) a body released here would settle in. */
export function cornerFor(body: Body, area: Area): { x: number; y: number } {
    const l = limits(area);
    const x = body.x + body.vx * LOOK_AHEAD;
    const y = body.y + body.vy * LOOK_AHEAD;
    return {
        x: x < (l.minX + l.maxX) / 2 ? l.minX : l.maxX,
        y: y < (l.minY + l.maxY) / 2 ? l.minY : l.maxY,
    };
}

/** At rest: on its corner and not moving. */
export const atRest = (body: Body, corner: { x: number; y: number }): boolean =>
    Math.hypot(body.vx, body.vy) < REST_SPEED &&
    Math.hypot(body.x - corner.x, body.y - corner.y) < REST_DISTANCE;

/** One step of `dt` seconds of the spring toward `corner`. A long step is split so the integration stays stable. */
export function step(body: Body, dt: number, area: Area, corner: { x: number; y: number }): Body {
    const raw = { minX: 0, maxX: Math.max(0, area.width - area.w), minY: 0, maxY: Math.max(0, area.height - area.h) };
    let { x, y, vx, vy } = body;
    let left = Math.min(dt, 0.25);
    const slice = 1 / 240;
    while (left > 0) {
        const d = Math.min(slice, left);
        left -= d;
        vx += (STIFFNESS * (corner.x - x) - DAMPING * vx) * d;
        vy += (STIFFNESS * (corner.y - y) - DAMPING * vy) * d;
        x += vx * d;
        y += vy * d;
    }
    // The overshoot may use the margin but never leaves the area.
    x = clamp(x, raw.minX, raw.maxX);
    y = clamp(y, raw.minY, raw.maxY);
    const next = { x, y, vx, vy };
    return atRest(next, corner) ? { x: corner.x, y: corner.y, vx: 0, vy: 0 } : next;
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
