/**
 * Drawing helpers for hand-made icons, in the same form as Phosphor: a stroke is shipped as its expanded outline.
 *
 * `strokePath` expands a centre line (open or closed polyline) with round caps and round joins: the outside of
 * each bend is an arc of radius width / 2 round the vertex, the inside is the sharp intersection of the two
 * offset lines. That is how Phosphor's outlines look before smoothing (a stroked square has radius-8 arcs outside
 * and sharp corners inside in the regular weight), so the build can round custom icons with the same rules and
 * they get the same corners as every other icon.
 *
 * `polygonPath` is a filled shape with sharp corners, for fill weights. The build rounds those corners too.
 */
import { type Vec, add, cross, intersectLines, rot90, scale, sub, unit, vec } from "../geometry.ts";

export type Point = readonly [number, number];

const fmt = (n: number): string => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
};
const xy = (p: Vec): string => `${fmt(p.x)},${fmt(p.y)}`;

/** One side of an expanded polyline: offset lines, joined by arcs on the outside of each bend. */
function offsetSide(pts: Vec[], h: number, closed: boolean): string[] {
    const n = pts.length;
    const segCount = closed ? n : n - 1;
    const dirs: Vec[] = [];
    for (let i = 0; i < segCount; i++) dirs.push(unit(sub(pts[(i + 1) % n] as Vec, pts[i] as Vec)));
    // Left of the direction of travel (in SVG's y-down space this is the outside of a clockwise shape).
    const normal = (d: Vec): Vec => scale(rot90(d), -1);
    const cmds: string[] = [];
    for (let i = 0; i < n; i++) {
        const p = pts[i] as Vec;
        const dIn = closed ? dirs[(i - 1 + segCount) % segCount] : i > 0 ? dirs[i - 1] : undefined;
        const dOut = closed ? dirs[i % segCount] : i < segCount ? dirs[i] : undefined;
        if (!dIn && dOut) {
            cmds.push(`L${xy(add(p, scale(normal(dOut), h)))}`);
            continue;
        }
        if (dIn && !dOut) {
            cmds.push(`L${xy(add(p, scale(normal(dIn), h)))}`);
            continue;
        }
        if (!dIn || !dOut) continue;
        const a = add(p, scale(normal(dIn), h));
        const b = add(p, scale(normal(dOut), h));
        const turn = cross(dIn, dOut);
        if (Math.abs(turn) < 1e-9) {
            cmds.push(`L${xy(a)}`);
            continue;
        }
        // normal() is on the left in y-down space; a turn with cross < 0 bends left, so the left side is inside.
        if (turn < 0) {
            const hit = intersectLines(a, dIn, b, dOut);
            cmds.push(`L${xy(hit ? add(a, scale(dIn, hit.s)) : a)}`);
        } else {
            cmds.push(`L${xy(a)}`, `A${fmt(h)},${fmt(h)},0,0,1,${xy(b)}`);
        }
    }
    return cmds;
}

/**
 * Outline of a stroke along `points` with the given width, round caps and round joins.
 * Open lines give one subpath; closed ones give the outer contour and the hole.
 */
export function strokePath(points: readonly Point[], width: number, closed = false): string {
    let pts = points.map(([x, y]) => vec(x, y));
    const h = width / 2;
    if (closed) {
        // The outside must be on the left of travel: clockwise on screen (y down), positive shoelace area.
        let area = 0;
        for (let i = 0; i < pts.length; i++) area += cross(pts[i] as Vec, pts[(i + 1) % pts.length] as Vec);
        if (area < 0) pts = [...pts].reverse();
        const outer = offsetSide(pts, h, true);
        const inner = offsetSide([...pts].reverse(), h, true);
        const close = (cmds: string[]): string => `M${cmds[0]?.slice(1)}${cmds.slice(1).join("")}Z`;
        return close(outer) + close(inner);
    }
    const left = offsetSide(pts, h, false);
    const right = offsetSide([...pts].reverse(), h, false);
    const cap = `A${fmt(h)},${fmt(h)},0,0,1,`;
    const rightStart = right[0]?.slice(1) ?? "";
    const leftStart = left[0]?.slice(1) ?? "";
    return `M${leftStart}${left.slice(1).join("")}${cap}${rightStart}${right.slice(1).join("")}${cap}${leftStart}Z`;
}

/** A filled polygon with sharp corners. */
export function polygonPath(points: readonly Point[]): string {
    return `M${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join("L")}Z`;
}

/** Points along a line from `a` towards `b`, for building shapes from an axis. */
export function along(a: Point, b: Point, t: number, side = 0): Point {
    const d = unit(sub(vec(b[0], b[1]), vec(a[0], a[1])));
    const n = rot90(d);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [a[0] + d.x * len * t + n.x * side, a[1] + d.y * len * t + n.y * side];
}
