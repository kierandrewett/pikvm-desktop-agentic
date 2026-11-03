/**
 * Artefact checks that compare a smoothed element with its source. They run on every icon so problems show up
 * without looking at all 4536 drawings by eye.
 *
 * - winding: every subpath must keep the sign of its area, or holes stop being holes.
 * - shrink: a subpath that loses a large share of its area has lost a detail (a dot, a thin slot).
 * - grow: a subpath that gains area has bulged out past the source shape.
 * - intersections: crossings between edges must not increase (no new loops or overlaps).
 * - thin: the narrowest gap between each pair of subpaths, where that gap is filled (the stroke width between a
 *   frame's outer contour and its hole), must not drop by more than THIN of the source gap. Area checks miss this: a
 *   frame whose outer corner is much rounder than its inner corner loses little area but its stroke goes thin at
 *   the corner (SidebarSimple went from 16 to 10 units before corners were paired, see pairCorners in smooth.ts).
 *   Per pair, because a narrower gap elsewhere (the space between the two frames of Columns) would hide it.
 * - gap: the same for empty space between two parts (a dot inside a frame). A rounded hole corner always moves in
 *   towards what is next to it, so space may tighten, but losing more than GAP of it means two parts start to merge.
 */
import { type Subpath, type Vec, flattenSubpath, polygonArea } from "./geometry.ts";

/** Allowed loss of a stroke width. Corner pairing allows 10%; the rest is margin for sampling. */
const THIN = 0.15;
/** Allowed loss of the empty space between two parts. */
const GAP = 0.5;
/** Gaps wider than this are not strokes (fill weights, separate shapes) and are not measured. */
const GAP_LIMIT = 30;

interface Gap {
    distance: number;
    /** Halfway between the two nearest points: inside the material for a stroke, outside it for space. */
    middle: Vec;
}

/** Nonzero winding number of a set of closed polygons at a point. */
function winding(polys: Vec[][], p: Vec): number {
    let w = 0;
    for (const pts of polys) {
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as Vec;
            const b = pts[(i + 1) % pts.length] as Vec;
            const side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
            if (a.y <= p.y) {
                if (b.y > p.y && side > 0) w++;
            } else if (b.y <= p.y && side < 0) w--;
        }
    }
    return w;
}

/**
 * Narrowest distance between each pair of subpaths ("i:j", i < j), for pairs closer than `limit`.
 * Query points are 2 units apart and measured against edges, bucketed in a grid of `limit`-sized cells.
 */
function pairGaps(polys: Vec[][], limit: number): Map<string, Gap> {
    const cell = Math.max(limit, 1);
    const key = (x: number, y: number): number => (Math.floor(x / cell) + 1024) * 4096 + Math.floor(y / cell) + 1024;
    interface GapEdge {
        a: Vec;
        b: Vec;
        poly: number;
    }
    const grid = new Map<number, GapEdge[]>();
    polys.forEach((pts, poly) => {
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i] as Vec;
            const q = pts[(i + 1) % pts.length] as Vec;
            // Long lines are one edge after flattening; split them so each piece sits in the cell it passes through.
            const parts = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (cell / 2)));
            for (let j = 0; j < parts; j++) {
                const a = { x: p.x + ((q.x - p.x) * j) / parts, y: p.y + ((q.y - p.y) * j) / parts };
                const b = { x: p.x + ((q.x - p.x) * (j + 1)) / parts, y: p.y + ((q.y - p.y) * (j + 1)) / parts };
                const k = key((a.x + b.x) / 2, (a.y + b.y) / 2);
                const bucket = grid.get(k);
                if (bucket) bucket.push({ a, b, poly });
                else grid.set(k, [{ a, b, poly }]);
            }
        }
    });
    const best = new Map<string, Gap>();
    polys.forEach((pts, poly) => {
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as Vec;
            const b = pts[(i + 1) % pts.length] as Vec;
            const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
            for (let k = 0; k < steps; k++) {
                const px = a.x + ((b.x - a.x) * k) / steps;
                const py = a.y + ((b.y - a.y) * k) / steps;
                const cx = Math.floor(px / cell);
                const cy = Math.floor(py / cell);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const bucket = grid.get((cx + dx + 1024) * 4096 + cy + dy + 1024);
                        if (!bucket) continue;
                        for (const e of bucket) {
                            if (e.poly === poly) continue;
                            const ex = e.b.x - e.a.x;
                            const ey = e.b.y - e.a.y;
                            const len2 = ex * ex + ey * ey;
                            const t =
                                len2 > 0 ? Math.max(0, Math.min(1, ((px - e.a.x) * ex + (py - e.a.y) * ey) / len2)) : 0;
                            const d = Math.hypot(px - e.a.x - ex * t, py - e.a.y - ey * t);
                            if (d >= limit) continue;
                            const pair = poly < e.poly ? `${poly}:${e.poly}` : `${e.poly}:${poly}`;
                            if (d >= (best.get(pair)?.distance ?? limit)) continue;
                            const middle = { x: (px + e.a.x + ex * t) / 2, y: (py + e.a.y + ey * t) / 2 };
                            best.set(pair, { distance: d, middle });
                        }
                    }
                }
            }
        }
    });
    return best;
}

export interface CheckResult {
    flags: string[];
    /** Smallest area ratio (smoothed / source) over all subpaths with a non-trivial area. */
    minRatio: number;
    maxRatio: number;
}

/** Proper crossings between non-adjacent polyline edges, over all subpaths of an element. */
function countIntersections(polys: Vec[][]): number {
    interface Edge {
        a: Vec;
        b: Vec;
        poly: number;
        index: number;
        size: number;
        minX: number;
        maxX: number;
    }
    const edges: Edge[] = [];
    polys.forEach((pts, poly) => {
        const size = pts.length;
        for (let i = 0; i < size; i++) {
            const a = pts[i] as Vec;
            const b = pts[(i + 1) % size] as Vec;
            if (a.x === b.x && a.y === b.y) continue;
            edges.push({ a, b, poly, index: i, size, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x) });
        }
    });
    edges.sort((p, q) => p.minX - q.minX);
    const orient = (p: Vec, q: Vec, r: Vec): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let count = 0;
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i] as Edge;
        for (let j = i + 1; j < edges.length; j++) {
            const f = edges[j] as Edge;
            if (f.minX > e.maxX) break;
            if (e.poly === f.poly) {
                const gap = Math.abs(e.index - f.index);
                if (gap <= 1 || gap === e.size - 1) continue;
            }
            const d1 = orient(e.a, e.b, f.a);
            const d2 = orient(e.a, e.b, f.b);
            const d3 = orient(f.a, f.b, e.a);
            const d4 = orient(f.a, f.b, e.b);
            const eps = 1e-6;
            if (
                ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
                ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
            )
                count++;
        }
    }
    return count;
}

export function checkElement(source: Subpath[], smoothed: Subpath[]): CheckResult {
    const flags: string[] = [];
    const before = source.map((sp) => flattenSubpath(sp, 0.1));
    const after = smoothed.map((sp) => flattenSubpath(sp, 0.1));
    let minRatio = 1;
    let maxRatio = 1;
    if (before.length !== after.length) flags.push("subpath-count");
    before.forEach((pts, i) => {
        const a0 = polygonArea(pts);
        const a1 = polygonArea(after[i] ?? []);
        if (Math.abs(a0) < 4) return;
        if (Math.sign(a0) !== Math.sign(a1)) flags.push(`winding:${i}`);
        const ratio = a1 / a0;
        minRatio = Math.min(minRatio, ratio);
        maxRatio = Math.max(maxRatio, ratio);
        if (ratio < 0.7) flags.push(`shrink:${i}:${ratio.toFixed(2)}`);
        if (ratio > 1.15) flags.push(`grow:${i}:${ratio.toFixed(2)}`);
    });
    const x0 = countIntersections(before);
    const x1 = countIntersections(after);
    if (x1 > x0) flags.push(`intersections:${x0}->${x1}`);
    if (before.length > 1 && before.length === after.length) {
        const gaps0 = pairGaps(before, GAP_LIMIT);
        const gaps1 = pairGaps(after, GAP_LIMIT);
        for (const [pair, { distance: g0, middle }] of gaps0) {
            // Subpaths that touch in the source (under 2 units) are one shape drawn in parts, not a stroke.
            if (g0 < 2) continue;
            const g1 = gaps1.get(pair)?.distance ?? GAP_LIMIT;
            const filled = winding(before, middle) !== 0;
            const kind = filled ? "thin" : "gap";
            if (g1 < g0 * (1 - (filled ? THIN : GAP))) flags.push(`${kind}:${pair}:${g0.toFixed(1)}->${g1.toFixed(1)}`);
        }
    }
    return { flags, minRatio, maxRatio };
}
