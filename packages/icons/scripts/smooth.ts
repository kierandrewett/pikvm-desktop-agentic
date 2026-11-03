/**
 * Corner smoothing for Phosphor outlines.
 *
 * Phosphor ships every weight as an expanded outline: a stroked rectangle is an outer contour with radius-16 arcs
 * plus a hole with sharp corners (stroke 16 around a radius-8 centre line). Rounding only the sharp corners would
 * make frames heavier at every corner. So the rule is additive: each corner gets `oldRadius + delta`. Outer and
 * inner contours keep the same radius difference (the stroke width), so the stroke keeps its thickness at corners.
 *
 * The rounded corner is the continuous ("squircle") corner that Figma calls corner smoothing: a cubic that eases in
 * from the straight edge with zero curvature, a circular arc over the middle (1 - smoothing) of the turn, and a
 * mirrored cubic out. The cubics are solved for curvature continuity with the arc (G2), not only tangent continuity.
 *
 * Stroke crossings (X, Plus, arrow shafts) stay as they are: rounding them gives blobs. A crossing is a corner that
 * is concave for its own subpath where both edges have a parallel "other side of the bar" within stroke distance
 * and those two other sides are not joined to each other (if they are joined, it is the inside of a bend instead).
 */
import {
    type Segment,
    type Subpath,
    type Vec,
    add,
    angleBetween,
    arc,
    cross,
    cubic,
    dist,
    dot,
    endTangent,
    flattenSubpath,
    intersectLines,
    polygonArea,
    rot90,
    rotate,
    sampleAtLength,
    scale,
    segmentLength,
    segmentTurning,
    signedAngle,
    startTangent,
    sub,
    trimSegment,
    unit,
} from "./geometry.ts";

export interface SmoothOptions {
    /** Radius added to every corner, in units of the 256 grid. */
    delta: number;
    /** Radius added at stroke crossings. 0 keeps them as Phosphor drew them. */
    junctionDelta: number;
    /** Corner smoothing, 0 = plain circular fillet, 1 = no circular part at all. */
    smoothing: number;
    /** Largest tan(turn / 2) that gets the full delta. Sharper tips get proportionally less (see acuteScale). */
    acuteTangent: number;
    /** Largest share of an adjacent segment one corner may use. Two corners on one segment stay below 2x this. */
    clamp: number;
    /** Turns smaller than this (radians) are not corners. */
    minTurn: number;
    /** Turns larger than this are caps or cusps and stay as they are. */
    maxTurn: number;
    /** A curved run between two lines counts as an existing fillet only if its tangent length is at most this. */
    maxFilletTangent: number;
    /** A curved run shorter than this between two lines counts as a sharp vertex (Phosphor's micro tips). */
    microRun: number;
    /** Largest radius of an arc between a line and a curve that counts as a fillet (gear teeth, bubble tails). */
    maxCurveFillet: number;
    /** Largest turn (radians) of the curve side over the part a fillet corner trims away. See straightLength. */
    curveTurn: number;
    /** Handle length of the connector cubic at corners next to curves, as a share of the tangent-line distance. */
    curveHandle: number;
    /** Stroke crossing search: the "other side" of a bar must be this close (grid units). */
    partnerMin: number;
    partnerMax: number;
    /** Join test for cut-out corners: how far along each edge the across-the-bar rays start. */
    probeStep: number;
    /** Largest share of the stroke width that a corner may lose (or gain) when its partner is clamped. */
    pairThinning: number;
}

export const DEFAULT_OPTIONS: SmoothOptions = {
    delta: 24,
    junctionDelta: 0,
    smoothing: 0.8,
    acuteTangent: 1.4,
    clamp: 0.45,
    minTurn: (5 * Math.PI) / 180,
    maxTurn: (170 * Math.PI) / 180,
    maxFilletTangent: 28,
    microRun: 2.5,
    maxCurveFillet: 12,
    curveTurn: (10 * Math.PI) / 180,
    curveHandle: 0.62,
    partnerMin: 2,
    partnerMax: 40,
    probeStep: 8,
    pairThinning: 0.1,
};

export interface SmoothStats {
    /** Lines whose trimmed direction flipped. Always a bug: two corners overran one line. Must stay 0. */
    reversed: number;
    rounded: number;
    /** Corners kept as drawn because two strokes join or cross there. */
    joins: number;
    clamped: number;
    nextToCurves: number;
}

const DEG = Math.PI / 180;
/** Corners shorter than this along each edge stay as drawn: 5x the output precision of 0.1 unit. */
const MIN_EXTENT = 0.5;

/** Corner between two lines, maybe with an existing curved run (fillet or micro tip) between them. */
interface LineCorner {
    kind: "lines";
    inLine: number;
    outLine: number;
    run: number[];
    vertex: Vec;
    d1: Vec;
    d2: Vec;
    r0: number;
    radius: number;
}

/**
 * Corner where at least one side is a curve: a sharp vertex, or a small fillet arc between a line and a curve.
 * `at` is the segment before the corner and `after` the segment after it; `run` is the fillet between them, if any.
 */
interface CurveCorner {
    kind: "curve";
    at: number;
    after: number;
    run: number[];
    vertex: Vec;
    d1: Vec;
    d2: Vec;
    r0: number;
    radius: number;
}

type Corner = LineCorner | CurveCorner;

interface SubpathPlan {
    sp: Subpath;
    orientation: number;
    /** True when the inside of this subpath is empty (a cut-out), under the nonzero fill rule. */
    hole: boolean;
    corners: Map<number, Corner>;
    absorbed: Set<number>;
}

const mod = (i: number, n: number): number => ((i % n) + n) % n;

/**
 * The continuous corner for a turn from direction d1 to d2 at vertex v.
 * Returns the replacement segments and how far along each edge (from v) the corner starts.
 */
export function continuousCorner(
    v: Vec,
    d1: Vec,
    d2: Vec,
    radius: number,
    smoothing: number,
    maxExtent: number,
    minRadius = 0,
): { pieces: Segment[]; extent: number; clamped: boolean } {
    const theta = angleBetween(d1, d2);
    const s = Math.sign(cross(d1, d2)) || 1;
    const tanHalf = Math.tan(theta / 2);
    let r = radius;
    let xi = smoothing;
    let t = r * tanHalf;
    let extent = (1 + xi) * t;
    let clamped = false;
    if (extent > maxExtent) {
        // Not Figma's order (smoothing first). Figma's order turns small squares into circles. Here the radius
        // shrinks first, down to the source radius, so small shapes stay squircles. Then smoothing goes, then
        // the radius below the source radius.
        clamped = true;
        const floor = Math.min(radius, minRadius);
        r = Math.max(floor, maxExtent / ((1 + xi) * tanHalf));
        t = r * tanHalf;
        if ((1 + xi) * t > maxExtent) xi = Math.max(0, maxExtent / t - 1);
        if (t > maxExtent) {
            t = maxExtent;
            r = t / tanHalf;
        }
        extent = (1 + xi) * t;
    }
    const n1 = scale(rot90(d1), s);
    const a = sub(v, scale(d1, t));
    const centre = add(a, scale(n1, r));
    const phi = (theta * xi) / 2;
    const arcFrom = (from: Vec, to: Vec, sweep: number): Segment => {
        const start = Math.atan2(from.y - centre.y, from.x - centre.x);
        return { ...arc(centre, r, start, sweep), p0: from, p1: to };
    };
    if (phi < 1e-4) {
        const b = add(v, scale(d2, t));
        return { pieces: [arcFrom(a, b, s * theta)], extent: t, clamped };
    }
    const q1 = sub(centre, scale(rotate(n1, s * phi), r));
    const q2 = sub(centre, scale(rotate(n1, s * (theta - phi)), r));
    const dq1 = rotate(d1, s * phi);
    const dq2 = rotate(d1, s * (theta - phi));
    // Distance from the arc end back along its tangent to the edge line.
    const m = (r * (1 - Math.cos(phi))) / Math.sin(phi);
    // Handle length on the edge line that makes curvature at the arc end equal 1 / r.
    const k = (1.5 * m * m) / (r * Math.sin(phi));
    const p2 = sub(q1, scale(dq1, m));
    const p0 = sub(v, scale(d1, extent));
    let p1 = sub(p2, scale(d1, k));
    if (dot(sub(v, p1), d1) > extent) p1 = p0;
    const p2b = add(q2, scale(dq2, m));
    const p0b = add(v, scale(d2, extent));
    let p1b = add(p2b, scale(d2, k));
    if (dot(sub(p1b, v), d2) > extent) p1b = p0b;
    const pieces: Segment[] = [cubic(p0, p1, p2, q1)];
    const middle = s * (theta - 2 * phi);
    if (Math.abs(middle) > 1e-4) pieces.push(arcFrom(q1, q2, middle));
    pieces.push(cubic(q2, p2b, p1b, p0b));
    return { pieces, extent, clamped };
}

/** Find corners in one subpath: fillet runs between lines first, then plain vertices. */
function findCorners(sp: Subpath, opts: SmoothOptions): SubpathPlan {
    const segs = sp.segments;
    const n = segs.length;
    const corners = new Map<number, Corner>();
    const absorbed = new Set<number>();
    const absorbedJunctions = new Set<number>();
    const orientation = Math.sign(polygonArea(flattenSubpath(sp))) || 1;
    const isLine = (i: number): boolean => segs[mod(i, n)]?.kind === "L";
    const seg = (i: number): Segment => segs[mod(i, n)] as Segment;
    const lineCount = segs.filter((s) => s.kind === "L").length;

    // Curved runs between two lines. Lines shorter than microRun belong to the run: some sources draw a sharp
    // vertex as two 0.3-unit lines (Pentagon's hole), and each would be a corner too small to round.
    const isEdge = (i: number): boolean => isLine(i) && segmentLength(seg(i)) >= opts.microRun;
    for (let i = 0; i < n && lineCount >= 2; i++) {
        if (!isEdge(i)) continue;
        if (!sp.closed && i === n - 1) continue;
        const run: number[] = [];
        let j = i + 1;
        while (!isEdge(j) && run.length < n) {
            if (!sp.closed && j >= n) break;
            run.push(mod(j, n));
            j++;
        }
        if (run.length === 0 || !isEdge(j)) continue;
        const outLine = mod(j, n);
        if (outLine === i) continue;
        const lin = seg(i);
        const lout = seg(outLine);
        const d1 = startTangent(lin);
        const d2 = startTangent(lout);
        const theta = angleBetween(d1, d2);
        if (theta < opts.minTurn || theta > opts.maxTurn) continue;

        const runLength = run.reduce((acc, k) => acc + segmentLength(seg(k)), 0);
        let total = 0;
        let absolute = 0;
        let prev = d1;
        for (const k of run) {
            const jump = signedAngle(prev, startTangent(seg(k)));
            const turn = segmentTurning(seg(k));
            total += jump + turn;
            absolute += Math.abs(jump) + Math.abs(turn);
            prev = endTangent(seg(k));
        }
        const lastJump = signedAngle(prev, d2);
        total += lastJump;
        absolute += Math.abs(lastJump);
        const signed = signedAngle(d1, d2);
        const micro = runLength < opts.microRun;
        // A micro run is a sharp vertex, so how it turns does not matter. Some sources draw one the wrong way round
        // (Tote: an r0.13 arc that turns against the corner), and the corner would stay sharp inside a round frame.
        if (!micro && (Math.abs(total - signed) > 8 * DEG || absolute > theta + 8 * DEG)) continue;

        if (!micro) {
            const first = seg(run[0] as number);
            const last = seg(run[run.length - 1] as number);
            if (angleBetween(d1, startTangent(first)) > 6 * DEG) continue;
            if (angleBetween(endTangent(last), d2) > 6 * DEG) continue;
        }
        const hit = intersectLines(lin.p1, d1, lout.p0, d2);
        if (!hit) continue;
        const t1 = hit.s;
        const t2 = -hit.u;
        if (t1 < -0.05 || t2 < -0.05 || t1 > opts.maxFilletTangent || t2 > opts.maxFilletTangent) continue;
        const vertex = add(lin.p1, scale(d1, hit.s));
        const r0 = micro ? 0 : (t1 + t2) / 2 / Math.tan(theta / 2);
        corners.set(i, { kind: "lines", inLine: i, outLine, run, vertex, d1, d2, r0, radius: r0 });
        for (const k of run) absorbed.add(k);
        for (let k = i; k !== outLine; k = mod(k + 1, n)) absorbedJunctions.add(k);
    }

    // A small fillet arc between a line and a curve (in either order). Phosphor rounds a gear tooth or a bubble
    // tail this way: line, radius-8 arc, big arc. All three joints are smooth, so the plain-vertex pass below sees
    // no corner and the tooth would keep its radius 8 while every frame round it gets r + delta.
    for (let j = 0; j < n; j++) {
        const f = seg(j);
        if (f.kind !== "A" || f.r > opts.maxCurveFillet || absorbed.has(j)) continue;
        if (!sp.closed && (j === 0 || j === n - 1)) continue;
        const prev = seg(j - 1);
        const next = seg(j + 1);
        if (absorbed.has(mod(j - 1, n)) || absorbed.has(mod(j + 1, n))) continue;
        // Exactly one neighbour is a line. Two lines are the first pass's job; two curves have no edge to trim.
        if ((prev.kind === "L") === (next.kind === "L")) continue;
        const d1 = endTangent(prev);
        const d2 = startTangent(next);
        if (angleBetween(d1, startTangent(f)) > 6 * DEG || angleBetween(endTangent(f), d2) > 6 * DEG) continue;
        const theta = angleBetween(d1, d2);
        if (theta < opts.minTurn || theta > opts.maxTurn) continue;
        if (Math.abs(Math.abs(f.delta) - theta) > 6 * DEG) continue;
        const hit = intersectLines(prev.p1, d1, next.p0, d2);
        if (!hit) continue;
        const at = mod(j - 1, n);
        corners.set(at, {
            kind: "curve",
            at,
            after: mod(j + 1, n),
            run: [j],
            vertex: add(prev.p1, scale(d1, hit.s)),
            d1,
            d2,
            r0: f.r,
            radius: f.r,
        });
        absorbed.add(j);
        absorbedJunctions.add(at);
        absorbedJunctions.add(j);
    }

    // Plain vertices.
    const junctions = sp.closed ? n : n - 1;
    for (let k = 0; k < junctions; k++) {
        if (absorbedJunctions.has(k) || absorbed.has(k)) continue;
        const a = seg(k);
        const b = seg(k + 1);
        const theta = angleBetween(endTangent(a), startTangent(b));
        if (theta < opts.minTurn || theta > opts.maxTurn) continue;
        if (a.kind === "L" && b.kind === "L") {
            corners.set(k, {
                kind: "lines",
                inLine: k,
                outLine: mod(k + 1, n),
                run: [],
                vertex: a.p1,
                d1: startTangent(a),
                d2: startTangent(b),
                r0: 0,
                radius: 0,
            });
        } else {
            corners.set(k, {
                kind: "curve",
                at: k,
                after: mod(k + 1, n),
                run: [],
                vertex: a.p1,
                d1: endTangent(a),
                d2: startTangent(b),
                r0: 0,
                radius: 0,
            });
        }
    }
    return { sp, orientation, hole: false, corners, absorbed };
}

interface LineRef {
    plan: number;
    index: number;
    p0: Vec;
    p1: Vec;
    d: Vec;
}

/** True when a concave corner is a stroke crossing rather than the inside of a bend. See file comment. */
function isCrossing(
    corner: LineCorner,
    planIndex: number,
    plan: SubpathPlan,
    lines: LineRef[],
    joined: Set<string>,
    opts: SmoothOptions,
): boolean {
    const { vertex, d1, d2 } = corner;
    const concave = Math.sign(cross(d1, d2)) !== plan.orientation;
    if (!concave) return false;
    const inLine = plan.sp.segments[corner.inLine] as Segment;
    const outLine = plan.sp.segments[corner.outLine] as Segment;
    const lenIn = dist(inLine.p0, vertex);
    const lenOut = dist(vertex, outLine.p1);
    const partners = (d: Vec, self: number, lo: number, hi: number): LineRef[] => {
        const normal = scale(rot90(d), plan.orientation);
        return lines.filter((f) => {
            if (f.plan === planIndex && f.index === self) return false;
            if (Math.abs(cross(f.d, d)) > Math.sin(3 * DEG)) return false;
            const w = dot(sub(f.p0, vertex), normal);
            if (w < opts.partnerMin || w > opts.partnerMax) return false;
            const a = dot(sub(f.p0, vertex), d);
            const b = dot(sub(f.p1, vertex), d);
            const fl = Math.min(a, b);
            const fh = Math.max(a, b);
            const rangeLo = lo === -Infinity ? -w : lo;
            const rangeHi = hi === Infinity ? w : hi;
            // A real overlap, not only touching: the far arm of a Plus touches the range at one point.
            return Math.min(fh, rangeHi) - Math.max(fl, rangeLo) > 1;
        });
    };
    const f1 = partners(d1, corner.inLine, -lenIn, Infinity);
    const f2 = partners(d2, corner.outLine, -Infinity, lenOut);
    if (f1.length === 0 || f2.length === 0) return false;
    for (const a of f1) for (const b of f2) if (joined.has(`${a.plan}:${a.index}:${b.index}`)) return false;
    return true;
}

/**
 * Share of delta to add at a corner. The tangent length is r * tan(turn / 2), so the same radius on a sharp tip
 * uses far more edge than on a right angle and blunts triangles into "D" shapes. Past the point where
 * tan(turn / 2) exceeds acuteTangent, the added radius shrinks so the added tangent length stays fixed.
 * Inner and outer contours of a stroked tip have the same turn, so both get the same addition.
 */
function acuteScale(d1: Vec, d2: Vec, opts: SmoothOptions): number {
    const tanHalf = Math.tan(angleBetween(d1, d2) / 2);
    return Math.min(1, opts.acuteTangent / tanHalf);
}

interface Edge {
    a: Vec;
    b: Vec;
    plan: number;
}

/** Nonzero winding number of the whole element at a point. */
function winding(edges: Edge[], p: Vec): number {
    let w = 0;
    for (const { a, b } of edges) {
        if (a.y <= p.y) {
            if (b.y > p.y && cross(sub(b, a), sub(p, a)) > 0) w++;
        } else if (b.y <= p.y && cross(sub(b, a), sub(p, a)) < 0) w--;
    }
    return w;
}

/** First boundary crossed by a ray: distance and the subpath it belongs to. */
function probe(edges: Edge[], origin: Vec, dir: Vec, maxDistance: number): { distance: number; plan: number } | null {
    let best: { distance: number; plan: number } | null = null;
    for (const e of edges) {
        const hit = intersectLines(origin, dir, e.a, sub(e.b, e.a));
        if (!hit || hit.s < 0.3 || hit.s > maxDistance || hit.u < 0 || hit.u > 1) continue;
        if (!best || hit.s < best.distance) best = { distance: hit.s, plan: e.plan };
    }
    return best;
}

/**
 * Join test for convex corners of cut-outs (globe cells, grid cells, hatch slots, a sidebar panel next to its
 * divider). Three rays go into the material: across the bar that each edge bounds (starting a short way along the
 * edge, so the ray crosses the bar and not the contour the bar runs into), and along the corner bisector. At a
 * bend of a frame all three leave through the same contour, so the corner is the inside of a round join and gets
 * rounded. At a T-join or a crossing the rays leave into different cut-outs; strokes overlap there, so the corner
 * stays as drawn, like a stroke-based icon. A ray with no exit in reach is in thick solid material (fill weights)
 * and agrees with any other ray.
 */
function isCellJoin(edges: Edge[], plan: SubpathPlan, vertex: Vec, d1: Vec, d2: Vec, opts: SmoothOptions): boolean {
    const reach = opts.partnerMax * 1.5;
    // Material lies away from the inside of a cut-out.
    const material1 = scale(rot90(d1), -plan.orientation);
    const material2 = scale(rot90(d2), -plan.orientation);
    const step = opts.probeStep;
    const rays: [Vec, Vec][] = [
        [add(vertex, scale(d2, step)), material2],
        [sub(vertex, scale(d1, step)), material1],
        [vertex, unit(add(material1, material2))],
    ];
    const exits = rays.map(([origin, dir]) => probe(edges, origin, dir, reach)?.plan).filter((p) => p !== undefined);
    return new Set(exits).size > 1;
}

/**
 * Longest stretch from one end of a curve over which its tangent turns by at most maxTurn. A fillet corner may
 * only trim a curve this far: past it the connector cuts across the curve's own bend (a bell flank, a round cap)
 * instead of easing into a nearly straight side (a gear tooth top, radius 107, turns 6 degrees over 11 units).
 */
function straightLength(s: Segment, fromEnd: boolean, maxTurn: number): number {
    const total = segmentLength(s);
    if (s.kind === "L") return total;
    if (s.kind === "A") return Math.min(total, s.r * maxTurn);
    const endTangentAt = fromEnd ? endTangent(s) : startTangent(s);
    const turnAt = (l: number): number =>
        angleBetween(endTangentAt, sampleAtLength(s, fromEnd ? total - l : l).tangent);
    if (turnAt(total) <= maxTurn) return total;
    let lo = 0;
    let hi = total;
    for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (turnAt(mid) <= maxTurn) lo = mid;
        else hi = mid;
    }
    return lo;
}

/** How far a corner next to a curve may trim each side, past the ends of its old fillet (if any). */
function curveExtentLimit(a: Segment, b: Segment, c: CurveCorner, opts: SmoothOptions): number {
    const limit = Math.min(opts.clamp * segmentLength(a), opts.clamp * segmentLength(b));
    if (c.run.length === 0) return limit;
    return Math.min(limit, straightLength(a, true, opts.curveTurn), straightLength(b, false, opts.curveTurn));
}

/** Smooth every subpath of one path element. Subpaths are planned together for the crossing tests. */
export function smoothElement(
    subpaths: Subpath[],
    opts: SmoothOptions = DEFAULT_OPTIONS,
): { subpaths: Subpath[]; stats: SmoothStats } {
    const stats: SmoothStats = { reversed: 0, rounded: 0, joins: 0, clamped: 0, nextToCurves: 0 };
    const plans = subpaths.map((sp) => findCorners(sp, opts));

    const edges: Edge[] = [];
    const polygons = plans.map((plan) => flattenSubpath(plan.sp, 0.5));
    polygons.forEach((pts, pi) => {
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as Vec;
            const b = pts[(i + 1) % pts.length] as Vec;
            if (dist(a, b) > 1e-9) edges.push({ a, b, plan: pi });
        }
    });
    // A subpath is a cut-out when a point just inside its longest edge is not filled.
    polygons.forEach((pts, pi) => {
        const plan = plans[pi] as SubpathPlan;
        let longest = -1;
        let probePoint: Vec | null = null;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as Vec;
            const b = pts[(i + 1) % pts.length] as Vec;
            const l = dist(a, b);
            if (l <= longest) continue;
            longest = l;
            const inward = scale(rot90(unit(sub(b, a))), plan.orientation * 0.25);
            probePoint = add(scale(add(a, b), 0.5), inward);
        }
        plan.hole = probePoint ? winding(edges, probePoint) === 0 : false;
    });

    const lines: LineRef[] = [];
    const joined = new Set<string>();
    plans.forEach((plan, pi) => {
        plan.sp.segments.forEach((s, index) => {
            if (s.kind === "L") lines.push({ plan: pi, index, p0: s.p0, p1: s.p1, d: unit(sub(s.p1, s.p0)) });
        });
        for (const c of plan.corners.values()) {
            if (c.kind !== "lines") continue;
            joined.add(`${pi}:${c.inLine}:${c.outLine}`);
            joined.add(`${pi}:${c.outLine}:${c.inLine}`);
        }
    });

    plans.forEach((plan, pi) => {
        for (const c of plan.corners.values()) {
            const concave = Math.sign(cross(c.d1, c.d2)) !== plan.orientation;
            let crossing: boolean;
            if (c.kind === "lines") {
                crossing = concave
                    ? isCrossing(c, pi, plan, lines, joined, opts)
                    : plan.hole && isCellJoin(edges, plan, c.vertex, c.d1, c.d2, opts);
            } else {
                // Concave corners next to a curve are where one stroke joins another (magnifier handle to ring,
                // speech tail to bubble). Rounding them grows webbing.
                crossing = concave || (plan.hole && isCellJoin(edges, plan, c.vertex, c.d1, c.d2, opts));
            }
            if (crossing) stats.joins++;
            c.radius = c.r0 + (crossing ? opts.junctionDelta : opts.delta) * acuteScale(c.d1, c.d2, opts);
        }
    });
    pairCorners(plans, opts);

    const out = plans.map((plan) => buildSubpath(plan, opts, stats));
    return { subpaths: out, stats };
}

/**
 * Length of each segment between virtual vertices: an existing fillet run that is rebuilt is removed first, so its
 * line ends move out to the vertex. A kept fillet keeps the line end where it is.
 */
function virtualLengths(plan: SubpathPlan): number[] {
    const segs = plan.sp.segments;
    const vStart = segs.map((s) => s.p0);
    const vEnd = segs.map((s) => s.p1);
    for (const c of plan.corners.values()) {
        if (c.kind !== "lines" || c.radius <= c.r0 + 1e-6) continue;
        vEnd[c.inLine] = c.vertex;
        vStart[c.outLine] = c.vertex;
    }
    return segs.map((_, i) => dist(vStart[i] as Vec, vEnd[i] as Vec));
}

/**
 * Keep the stroke width round a corner when the clamp limits only one side of the stroke.
 *
 * The additive rule gives the outer and inner corner of a stroke the same added radius, so the gap between them
 * stays the stroke width. The clamp can break that: a narrow cut-out (the panel of SidebarSimple, 32 units wide)
 * shrinks its inner radius from 24 to 8 while the outer frame corner keeps 40, and the stroke thins from 16 to 10
 * at that corner. So each rounded corner finds its partner across the stroke (the nearest rounded corner on the
 * inside of the turn with parallel edges, both within stroke distance), and the added radii of the two may differ
 * by at most the amount that changes the stroke width by pairThinning at the corner apex. The apex gap is
 * w - dr * (1 / cos(turn / 2) - 1) for a radius difference dr (the smoothed corner's middle arc lies on the same
 * circle as a plain fillet). Exact equality would put every frame round a tiny hole (Columns bold, BoundingBox)
 * back to the source radius; 10% lets those soften a little while the stroke still reads as even.
 * A partner kept as drawn (a join, as inside the Trophy handles) counts with nothing added, so the outer corner
 * only gets the slack. Repeated, because nested frames (Copy, Cards) make chains.
 */
function pairCorners(plans: SubpathPlan[], opts: SmoothOptions): void {
    interface Item {
        c: Corner;
        tanHalf: number;
        reach: number;
        /** False for a corner kept as drawn (a join). It can be the inner partner, with nothing added. */
        rounded: boolean;
    }
    const parallel = (a: Vec, b: Vec): boolean => Math.abs(cross(a, b)) < Math.sin(3 * DEG);
    const collect = (): Item[] =>
        plans.flatMap((plan) => {
            const lengths = virtualLengths(plan);
            const segs = plan.sp.segments;
            return [...plan.corners.values()].flatMap((c): Item[] => {
                const tanHalf = Math.tan(angleBetween(c.d1, c.d2) / 2);
                if (c.radius <= c.r0 + 1e-6) return [{ c, tanHalf, reach: c.r0, rounded: false }];
                const k = (1 + opts.smoothing) * tanHalf;
                // The largest radius each builder in buildSubpath can reach before its limits cut in.
                if (c.kind === "lines") {
                    const maxExtent = opts.clamp * Math.min(lengths[c.inLine] ?? 0, lengths[c.outLine] ?? 0);
                    return [{ c, tanHalf, reach: maxExtent / k, rounded: true }];
                }
                const limit = curveExtentLimit(segs[c.at] as Segment, segs[c.after] as Segment, c, opts);
                return [{ c, tanHalf, reach: (limit + c.r0 * tanHalf) / k, rounded: true }];
            });
        });
    const added = (item: Item): number => Math.max(0, Math.min(item.c.radius, item.reach) - item.c.r0);
    for (let pass = 0; pass < 4; pass++) {
        const items = collect();
        let changed = false;
        for (const outer of items) {
            if (!outer.rounded) continue;
            const { vertex, d1, d2 } = outer.c;
            const turn = Math.sign(cross(d1, d2));
            let best: Item | null = null;
            let bestDistance = Infinity;
            let bestWidth = 0;
            for (const inner of items) {
                if (inner === outer) continue;
                const e = inner.c;
                const sameOrder = parallel(d1, e.d1) && parallel(d2, e.d2);
                if (!sameOrder && !(parallel(d1, e.d2) && parallel(d2, e.d1))) continue;
                const offset = sub(e.vertex, vertex);
                const w1 = cross(d1, offset) * turn;
                const w2 = cross(d2, offset) * turn;
                if (w1 < opts.partnerMin || w1 > opts.partnerMax || w2 < opts.partnerMin || w2 > opts.partnerMax)
                    continue;
                const distance = Math.hypot(offset.x, offset.y);
                if (distance < bestDistance) {
                    best = inner;
                    bestDistance = distance;
                    bestWidth = (w1 + w2) / 2;
                }
            }
            if (!best) continue;
            const apex = 1 / Math.cos(Math.atan(outer.tanHalf)) - 1;
            const slack = apex > 1e-6 ? (opts.pairThinning * bestWidth) / apex : Infinity;
            const addedOuter = added(outer);
            const addedInner = added(best);
            for (const [item, limit] of [
                [outer, addedInner + slack],
                [best, addedOuter + slack],
            ] as const) {
                const target = item.c.r0 + Math.min(added(item), limit);
                if (item.c.radius > target + 1e-6) {
                    item.c.radius = target;
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
}

function buildSubpath(plan: SubpathPlan, opts: SmoothOptions, stats: SmoothStats): Subpath {
    const { sp, corners, absorbed } = plan;
    const segs = sp.segments;
    const n = segs.length;
    const seg = (i: number): Segment => segs[mod(i, n)] as Segment;

    // Lines are measured between virtual vertices: an existing fillet run is removed before rounding again.
    const lengths = virtualLengths(plan);
    const virtualLength = (i: number): number => lengths[i] ?? 0;

    const newStart = segs.map((s) => s.p0);
    const newEnd = segs.map((s) => s.p1);
    const head = segs.map(() => 0);
    const tail = segs.map(() => 0);
    const pieces = new Map<number, Segment[]>();

    for (const [key, c] of corners) {
        if (c.kind === "lines") {
            const changed = c.radius > c.r0 + 1e-6;
            if (!changed) continue;
            const maxExtent = opts.clamp * Math.min(virtualLength(c.inLine), virtualLength(c.outLine));
            const corner = continuousCorner(c.vertex, c.d1, c.d2, c.radius, opts.smoothing, maxExtent, c.r0);
            // Too small to see, and output rounding would fold the pieces back on themselves. Keep as drawn.
            if (corner.extent < MIN_EXTENT) continue;
            newEnd[c.inLine] = sub(c.vertex, scale(c.d1, corner.extent));
            newStart[c.outLine] = add(c.vertex, scale(c.d2, corner.extent));
            pieces.set(key, corner.pieces);
            stats.rounded++;
            if (corner.clamped) stats.clamped++;
            continue;
        }
        const ia = c.at;
        const ib = c.after;
        const a = seg(ia);
        const b = seg(ib);
        const ta = endTangent(a);
        const tb = startTangent(b);
        const theta = angleBetween(ta, tb);
        const lenA = segmentLength(a);
        const lenB = segmentLength(b);
        if (c.radius <= c.r0 + 1e-6) continue;
        // Measured from the ends of the old fillet, which already covers r0 * tan(theta / 2) of each edge.
        const ideal = (1 + opts.smoothing) * c.radius * Math.tan(theta / 2) - c.r0 * Math.tan(theta / 2);
        const extent = Math.min(ideal, curveExtentLimit(a, b, c, opts));
        if (extent < MIN_EXTENT) continue;
        let s1: Vec;
        let t1: Vec;
        if (a.kind === "L") {
            s1 = sub(a.p1, scale(ta, extent));
            t1 = ta;
            newEnd[ia] = s1;
        } else {
            const sample = sampleAtLength(a, lenA - extent);
            s1 = sample.point;
            t1 = sample.tangent;
            tail[ia] = extent;
        }
        let s2: Vec;
        let t2: Vec;
        if (b.kind === "L") {
            s2 = add(b.p0, scale(tb, extent));
            t2 = tb;
            newStart[ib] = s2;
        } else {
            const sample = sampleAtLength(b, extent);
            s2 = sample.point;
            t2 = sample.tangent;
            head[ib] = extent;
        }
        const chord = dist(s1, s2);
        const hit = intersectLines(s1, t1, s2, t2);
        let h1 = chord / 3;
        let h2 = chord / 3;
        if (hit && hit.s > 0 && hit.u < 0) {
            // A fillet corner must not come out sharper than the fillet it replaces. When a limit keeps the new
            // corner short, curveHandle (0.62) is pointier than a circular arc for turns over 60 degrees, and a hole
            // corner then pushes into its stroke. Cap the ratio at the circle's: (4/3) tan(turn/4) / tan(turn/2).
            const turn = angleBetween(t1, t2);
            const circle = (4 / 3) * (Math.tan(turn / 4) / Math.tan(turn / 2));
            const ratio = c.run.length > 0 ? Math.min(opts.curveHandle, circle) : opts.curveHandle;
            h1 = Math.min(ratio * hit.s, chord);
            h2 = Math.min(ratio * -hit.u, chord);
        }
        pieces.set(key, [cubic(s1, add(s1, scale(t1, h1)), sub(s2, scale(t2, h2)), s2)]);
        stats.rounded++;
        stats.nextToCurves++;
        if (extent < ideal - 1e-6) stats.clamped++;
    }

    const out: Segment[] = [];
    for (let k = 0; k < n; k++) {
        if (absorbed.has(k)) continue;
        const s = seg(k);
        if (s.kind === "L") {
            const a = newStart[k] as Vec;
            const b = newEnd[k] as Vec;
            if (dot(sub(b, a), sub(s.p1, s.p0)) < -1e-6) stats.reversed++;
            if (dist(a, b) > 1e-3) out.push({ kind: "L", p0: a, p1: b });
        } else {
            out.push(trimSegment(s, head[k] ?? 0, tail[k] ?? 0));
        }
        const c = corners.get(k);
        const replacement = pieces.get(k);
        if (replacement) out.push(...replacement);
        else if (c) for (const r of c.run) out.push(seg(r));
    }
    return { segments: out, closed: sp.closed };
}
