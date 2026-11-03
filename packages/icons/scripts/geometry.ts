/**
 * Plane geometry for the icon smoother: vectors and three segment kinds (line, cubic, circular arc).
 *
 * Elliptical arcs are converted to cubics at parse time, so every arc here is circular. That keeps arc
 * maths exact (tangents, trimming, length) and lets the smoother recognise Phosphor's round joins by radius.
 */

export interface Vec {
    x: number;
    y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => vec(a.x + b.x, a.y + b.y);
export const sub = (a: Vec, b: Vec): Vec => vec(a.x - b.x, a.y - b.y);
export const scale = (a: Vec, k: number): Vec => vec(a.x * k, a.y * k);
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
/** Rotate by +90 degrees in the algebraic sense, so cross(d, rot90(d)) > 0. */
export const rot90 = (a: Vec): Vec => vec(-a.y, a.x);
export const rotate = (a: Vec, angle: number): Vec => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return vec(a.x * c - a.y * s, a.x * s + a.y * c);
};
export const unit = (a: Vec): Vec => {
    const l = length(a);
    return l === 0 ? vec(0, 0) : vec(a.x / l, a.y / l);
};
/** Unsigned angle between two directions, in radians, in [0, PI]. */
export const angleBetween = (a: Vec, b: Vec): number => Math.atan2(Math.abs(cross(a, b)), dot(a, b));
/** Signed angle that rotates direction a onto direction b, in (-PI, PI]. */
export const signedAngle = (a: Vec, b: Vec): number => Math.atan2(cross(a, b), dot(a, b));

export interface LineSeg {
    kind: "L";
    p0: Vec;
    p1: Vec;
}

export interface CubicSeg {
    kind: "C";
    p0: Vec;
    c1: Vec;
    c2: Vec;
    p1: Vec;
}

/** Circular arc in centre form. `delta` is signed: positive follows the SVG sweep-flag=1 direction. */
export interface ArcSeg {
    kind: "A";
    p0: Vec;
    p1: Vec;
    centre: Vec;
    r: number;
    start: number;
    delta: number;
}

export type Segment = LineSeg | CubicSeg | ArcSeg;

export interface Subpath {
    segments: Segment[];
    closed: boolean;
}

export const line = (p0: Vec, p1: Vec): LineSeg => ({ kind: "L", p0, p1 });
export const cubic = (p0: Vec, c1: Vec, c2: Vec, p1: Vec): CubicSeg => ({ kind: "C", p0, c1, c2, p1 });

export const arcPoint = (centre: Vec, r: number, angle: number): Vec =>
    vec(centre.x + r * Math.cos(angle), centre.y + r * Math.sin(angle));

export function arc(centre: Vec, r: number, start: number, delta: number): ArcSeg {
    return {
        kind: "A",
        p0: arcPoint(centre, r, start),
        p1: arcPoint(centre, r, start + delta),
        centre,
        r,
        start,
        delta,
    };
}

function cubicPoint(s: CubicSeg, t: number): Vec {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return vec(a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x, a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y);
}

function cubicDerivative(s: CubicSeg, t: number): Vec {
    const u = 1 - t;
    const a = 3 * u * u;
    const b = 6 * u * t;
    const c = 3 * t * t;
    return vec(
        a * (s.c1.x - s.p0.x) + b * (s.c2.x - s.c1.x) + c * (s.p1.x - s.c2.x),
        a * (s.c1.y - s.p0.y) + b * (s.c2.y - s.c1.y) + c * (s.p1.y - s.c2.y),
    );
}

/** Sub-curve of a cubic between parameters t0 and t1 (de Casteljau, twice). */
function cubicSlice(s: CubicSeg, t0: number, t1: number): CubicSeg {
    const split = (c: CubicSeg, t: number): [CubicSeg, CubicSeg] => {
        const a = lerp(c.p0, c.c1, t);
        const b = lerp(c.c1, c.c2, t);
        const d = lerp(c.c2, c.p1, t);
        const ab = lerp(a, b, t);
        const bd = lerp(b, d, t);
        const m = lerp(ab, bd, t);
        return [cubic(c.p0, a, ab, m), cubic(m, bd, d, c.p1)];
    };
    if (t1 <= t0) {
        const p = cubicPoint(s, t0);
        return cubic(p, p, p, p);
    }
    let c = s;
    if (t1 < 1) c = split(c, t1)[0];
    if (t0 > 0) c = split(c, t0 / t1)[1];
    return c;
}

/** Cumulative arc length table for a cubic, sampled at uniform t. Good to well under 0.01 units here. */
const TABLE_STEPS = 64;
function cubicLengthTable(s: CubicSeg): number[] {
    const table = [0];
    let prev = s.p0;
    let total = 0;
    for (let i = 1; i <= TABLE_STEPS; i++) {
        const p = cubicPoint(s, i / TABLE_STEPS);
        total += dist(prev, p);
        table.push(total);
        prev = p;
    }
    return table;
}

function cubicParamAtLength(s: CubicSeg, l: number): number {
    const table = cubicLengthTable(s);
    const total = table[TABLE_STEPS] ?? 0;
    if (l <= 0) return 0;
    if (l >= total) return 1;
    let i = 1;
    while (i < TABLE_STEPS && (table[i] ?? 0) < l) i++;
    const a = table[i - 1] ?? 0;
    const b = table[i] ?? a;
    const f = b > a ? (l - a) / (b - a) : 0;
    return (i - 1 + f) / TABLE_STEPS;
}

export function segmentLength(s: Segment): number {
    switch (s.kind) {
        case "L":
            return dist(s.p0, s.p1);
        case "A":
            return Math.abs(s.delta) * s.r;
        case "C":
            return cubicLengthTable(s)[TABLE_STEPS] ?? 0;
    }
}

/** Unit tangent at the start, in the direction of travel. Falls back across degenerate control points. */
export function startTangent(s: Segment): Vec {
    switch (s.kind) {
        case "L":
            return unit(sub(s.p1, s.p0));
        case "A":
            return unit(scale(rot90(sub(s.p0, s.centre)), Math.sign(s.delta)));
        case "C": {
            for (const q of [s.c1, s.c2, s.p1]) if (dist(q, s.p0) > 1e-6) return unit(sub(q, s.p0));
            return vec(0, 0);
        }
    }
}

export function endTangent(s: Segment): Vec {
    switch (s.kind) {
        case "L":
            return unit(sub(s.p1, s.p0));
        case "A":
            return unit(scale(rot90(sub(s.p1, s.centre)), Math.sign(s.delta)));
        case "C": {
            for (const q of [s.c2, s.c1, s.p0]) if (dist(q, s.p1) > 1e-6) return unit(sub(s.p1, q));
            return vec(0, 0);
        }
    }
}

/** Point and unit tangent at an arc-length distance from the start. */
export function sampleAtLength(s: Segment, l: number): { point: Vec; tangent: Vec } {
    switch (s.kind) {
        case "L": {
            const d = unit(sub(s.p1, s.p0));
            return { point: add(s.p0, scale(d, l)), tangent: d };
        }
        case "A": {
            const angle = s.start + Math.sign(s.delta) * (l / s.r);
            const point = arcPoint(s.centre, s.r, angle);
            return { point, tangent: unit(scale(rot90(sub(point, s.centre)), Math.sign(s.delta))) };
        }
        case "C": {
            const t = cubicParamAtLength(s, l);
            const d = cubicDerivative(s, t);
            const tangent = length(d) > 1e-9 ? unit(d) : t < 0.5 ? startTangent(s) : endTangent(s);
            return { point: cubicPoint(s, t), tangent };
        }
    }
}

/** Remove `head` units of arc length from the start and `tail` units from the end. */
export function trimSegment(s: Segment, head: number, tail: number): Segment {
    if (head <= 0 && tail <= 0) return s;
    const total = segmentLength(s);
    switch (s.kind) {
        case "L": {
            const d = unit(sub(s.p1, s.p0));
            return line(add(s.p0, scale(d, head)), sub(s.p1, scale(d, tail)));
        }
        case "A": {
            const sign = Math.sign(s.delta);
            return arc(s.centre, s.r, s.start + (sign * head) / s.r, s.delta - (sign * (head + tail)) / s.r);
        }
        case "C":
            return cubicSlice(s, cubicParamAtLength(s, head), cubicParamAtLength(s, total - tail));
    }
}

/** Signed total turning of the tangent along a segment, in radians. */
export function segmentTurning(s: Segment): number {
    switch (s.kind) {
        case "L":
            return 0;
        case "A":
            return s.delta;
        case "C": {
            let total = 0;
            let prev = startTangent(s);
            const steps = 32;
            for (let i = 1; i <= steps; i++) {
                const d = i === steps ? endTangent(s) : unit(cubicDerivative(s, i / steps));
                if (length(d) === 0) continue;
                total += signedAngle(prev, d);
                prev = d;
            }
            return total;
        }
    }
}

/** Polyline approximation. Lines give their end point only; curves give interior points plus the end point. */
export function flatten(s: Segment, tolerance = 0.25): Vec[] {
    switch (s.kind) {
        case "L":
            return [s.p1];
        case "A": {
            const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / s.r)));
            const n = Math.max(1, Math.ceil(Math.abs(s.delta) / Math.max(step, 1e-3)));
            const out: Vec[] = [];
            for (let i = 1; i <= n; i++) out.push(arcPoint(s.centre, s.r, s.start + (s.delta * i) / n));
            out[out.length - 1] = s.p1;
            return out;
        }
        case "C": {
            const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(segmentLength(s) / tolerance))));
            const out: Vec[] = [];
            for (let i = 1; i <= n; i++) out.push(cubicPoint(s, i / n));
            out[out.length - 1] = s.p1;
            return out;
        }
    }
}

export function flattenSubpath(sp: Subpath, tolerance = 0.25): Vec[] {
    const first = sp.segments[0];
    if (!first) return [];
    const out = [first.p0];
    for (const s of sp.segments) out.push(...flatten(s, tolerance));
    return out;
}

/** Signed shoelace area of a closed polyline. Positive means the path turns towards rot90 (cross > 0). */
export function polygonArea(points: Vec[]): number {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        if (p && q) a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}

/** Intersection of two infinite lines given as point + direction. Returns the parameters along each. */
export function intersectLines(p: Vec, d: Vec, q: Vec, e: Vec): { s: number; u: number } | null {
    const den = cross(d, e);
    if (Math.abs(den) < 1e-9) return null;
    const w = sub(q, p);
    return { s: cross(w, e) / den, u: cross(w, d) / den };
}
