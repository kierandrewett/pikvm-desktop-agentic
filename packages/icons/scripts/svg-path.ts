/**
 * SVG path data in and out.
 *
 * parsePath: any `d` string to absolute segments (line, cubic, circular arc). H/V become lines, Q/T/S become
 * cubics, elliptical arcs become cubics. Zero-length segments are dropped. Z adds the closing line when needed.
 *
 * serialisePath: segments to a compact `d`. Coordinates are rounded to 1/10 unit (0.005 px at 24 px, 0.05 px even at
 * 256 px) and handled as integer hundredths, so relative commands never drift and the output is deterministic.
 */
import { type Segment, type Subpath, type Vec, add, arc, cubic, dist, line, scale, sub, vec } from "./geometry.ts";

const EPSILON = 1e-4;
/** Gaps before Z shorter than this are closed by snapping, not by a closing line. */
const CLOSE_SNAP = 0.15;

class Scanner {
    private i = 0;
    constructor(private readonly s: string) {}

    private skip(): void {
        while (this.i < this.s.length && /[\s,]/.test(this.s[this.i] ?? "")) this.i++;
    }

    done(): boolean {
        this.skip();
        return this.i >= this.s.length;
    }

    peekCommand(): string | null {
        this.skip();
        const c = this.s[this.i] ?? "";
        return /[MmLlHhVvCcSsQqTtAaZz]/.test(c) ? c : null;
    }

    command(): string {
        const c = this.peekCommand();
        if (!c) throw new Error(`[svg-path] expected a command at ${this.i}: ${this.s.slice(this.i, this.i + 20)}`);
        this.i++;
        return c;
    }

    number(): number {
        this.skip();
        const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i));
        if (!m) throw new Error(`[svg-path] expected a number at ${this.i}: ${this.s.slice(this.i, this.i + 20)}`);
        this.i += m[0].length;
        return Number(m[0]);
    }

    /** Arc flags may be packed without separators ("a8 8 0 01 5 5"), so read exactly one character. */
    flag(): boolean {
        this.skip();
        const c = this.s[this.i];
        if (c !== "0" && c !== "1") throw new Error(`[svg-path] expected an arc flag at ${this.i}`);
        this.i++;
        return c === "1";
    }
}

/** SVG arc endpoint form to segments (spec section B.2.4). Circular arcs stay arcs, ellipses become cubics. */
function arcSegments(
    p0: Vec,
    p1: Vec,
    rxIn: number,
    ryIn: number,
    rotationDeg: number,
    large: boolean,
    sweep: boolean,
): Segment[] {
    if (dist(p0, p1) < EPSILON) return [];
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (rx < EPSILON || ry < EPSILON) return [line(p0, p1)];
    const phi = (rotationDeg * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const dx = (p0.x - p1.x) / 2;
    const dy = (p0.y - p1.y) / 2;
    const x1 = cosPhi * dx + sinPhi * dy;
    const y1 = -sinPhi * dx + cosPhi * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
    const cx1 = (coef * rx * y1) / ry;
    const cy1 = (-coef * ry * x1) / rx;
    const cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2;
    const cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number =>
        Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (sweep && delta < 0) delta += 2 * Math.PI;
    if (!sweep && delta > 0) delta -= 2 * Math.PI;

    if (Math.abs(rx - ry) <= 1e-3 * Math.max(rx, ry)) {
        // Circle: the angle in the rotated frame plus phi is the real angle.
        const a = arc(vec(cx, cy), (rx + ry) / 2, theta1 + phi, delta);
        // Pin the end points to the exact input so neighbouring segments stay connected.
        return [{ ...a, p0, p1 }];
    }

    // Ellipse: approximate with cubics, at most 90 degrees each.
    const pieces = Math.ceil(Math.abs(delta) / (Math.PI / 2));
    const step = delta / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    const point = (t: number): Vec => {
        const x = rx * Math.cos(t);
        const y = ry * Math.sin(t);
        return vec(cosPhi * x - sinPhi * y + cx, sinPhi * x + cosPhi * y + cy);
    };
    const deriv = (t: number): Vec => {
        const x = -rx * Math.sin(t);
        const y = ry * Math.cos(t);
        return vec(cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y);
    };
    const out: Segment[] = [];
    for (let i = 0; i < pieces; i++) {
        const a = theta1 + i * step;
        const b = a + step;
        const s = i === 0 ? p0 : point(a);
        const e = i === pieces - 1 ? p1 : point(b);
        out.push(cubic(s, add(s, scale(deriv(a), k)), sub(e, scale(deriv(b), k)), e));
    }
    return out;
}

export function parsePath(d: string): Subpath[] {
    const sc = new Scanner(d);
    const out: Subpath[] = [];
    let current: Subpath | null = null;
    let pos = vec(0, 0);
    let start = vec(0, 0);
    let lastControl: Vec | null = null;
    let lastQuad: Vec | null = null;
    let cmd = "";

    const push = (s: Segment): void => {
        if (!current) {
            current = { segments: [], closed: false };
            out.push(current);
            start = s.p0;
        }
        const degenerate =
            dist(s.p0, s.p1) < EPSILON &&
            (s.kind !== "C" || (dist(s.p0, s.c1) < EPSILON && dist(s.p0, s.c2) < EPSILON));
        if (!degenerate) current.segments.push(s);
    };

    while (!sc.done()) {
        const next = sc.peekCommand();
        if (next) cmd = sc.command();
        else if (!cmd) throw new Error("[svg-path] path data must start with a command");
        const rel = cmd === cmd.toLowerCase();
        const at = (x: number, y: number): Vec => (rel ? vec(pos.x + x, pos.y + y) : vec(x, y));
        const upper = cmd.toUpperCase();
        let control: Vec | null = null;
        let quad: Vec | null = null;
        switch (upper) {
            case "M": {
                pos = at(sc.number(), sc.number());
                start = pos;
                current = { segments: [], closed: false };
                out.push(current);
                // Following coordinate pairs are implicit line-to commands.
                cmd = rel ? "l" : "L";
                break;
            }
            case "L": {
                const p = at(sc.number(), sc.number());
                push(line(pos, p));
                pos = p;
                break;
            }
            case "H": {
                const x = sc.number();
                const p = vec(rel ? pos.x + x : x, pos.y);
                push(line(pos, p));
                pos = p;
                break;
            }
            case "V": {
                const y = sc.number();
                const p = vec(pos.x, rel ? pos.y + y : y);
                push(line(pos, p));
                pos = p;
                break;
            }
            case "C": {
                const c1 = at(sc.number(), sc.number());
                const c2 = at(sc.number(), sc.number());
                const p = at(sc.number(), sc.number());
                push(cubic(pos, c1, c2, p));
                control = c2;
                pos = p;
                break;
            }
            case "S": {
                const c1 = lastControl ? sub(scale(pos, 2), lastControl) : pos;
                const c2 = at(sc.number(), sc.number());
                const p = at(sc.number(), sc.number());
                push(cubic(pos, c1, c2, p));
                control = c2;
                pos = p;
                break;
            }
            case "Q":
            case "T": {
                const ctrl: Vec =
                    upper === "Q" ? at(sc.number(), sc.number()) : lastQuad ? sub(scale(pos, 2), lastQuad) : pos;
                const p = at(sc.number(), sc.number());
                const c1 = add(pos, scale(sub(ctrl, pos), 2 / 3));
                const c2 = add(p, scale(sub(ctrl, p), 2 / 3));
                push(cubic(pos, c1, c2, p));
                quad = ctrl;
                pos = p;
                break;
            }
            case "A": {
                const rx = sc.number();
                const ry = sc.number();
                const rotation = sc.number();
                const large = sc.flag();
                const sweep = sc.flag();
                const p = at(sc.number(), sc.number());
                for (const s of arcSegments(pos, p, rx, ry, rotation, large, sweep)) push(s);
                pos = p;
                break;
            }
            case "Z": {
                if (current) {
                    const sp: Subpath = current;
                    // Phosphor often ends a loop a few hundredths short of its start. A closing line that short
                    // turns into a spike once coordinates are rounded, so snap instead of adding it.
                    if (dist(pos, start) >= CLOSE_SNAP) push(line(pos, start));
                    else {
                        // Snap the last end point onto the start so the loop is exactly closed.
                        const last = sp.segments[sp.segments.length - 1];
                        if (last) last.p1 = start;
                    }
                    sp.closed = true;
                }
                pos = start;
                current = null;
                break;
            }
        }
        lastControl = control;
        lastQuad = quad;
    }
    return out.filter((sp) => sp.segments.length > 0).map(dropMicroLines);
}

/**
 * Remove lines shorter than CLOSE_SNAP and join their neighbours. Phosphor has a few hundredth-unit lines
 * ("l-.09.09") that only exist from its own rounding. After output rounding they point in a new direction and
 * fold the outline over itself.
 */
function dropMicroLines(sp: Subpath): Subpath {
    if (sp.segments.length < 3) return sp;
    const kept = sp.segments.filter((s) => s.kind !== "L" || dist(s.p0, s.p1) >= CLOSE_SNAP);
    if (kept.length === sp.segments.length || kept.length < 2) return sp;
    const n = kept.length;
    const segments = kept.map((s) => ({ ...s }));
    for (let i = 0; i < n; i++) {
        const next = segments[i + 1] ?? (sp.closed ? segments[0] : undefined);
        const cur = segments[i];
        if (cur && next && dist(cur.p1, next.p0) > 0) next.p0 = cur.p1;
    }
    return { segments, closed: sp.closed };
}

/** Convert <rect>, <circle>, <ellipse>, <line>, <polyline> and <polygon> attributes to path data. */
export function shapeToPath(tag: string, attrs: Record<string, string>): string | null {
    const n = (k: string): number => Number(attrs[k] ?? 0);
    switch (tag) {
        case "rect": {
            const x = n("x");
            const y = n("y");
            const w = n("width");
            const h = n("height");
            let rx = attrs.rx !== undefined ? n("rx") : n("ry");
            let ry = attrs.ry !== undefined ? n("ry") : rx;
            rx = Math.min(rx, w / 2);
            ry = Math.min(ry, h / 2);
            if (rx <= 0 || ry <= 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
            return (
                `M${x + rx},${y}H${x + w - rx}A${rx},${ry},0,0,1,${x + w},${y + ry}V${y + h - ry}` +
                `A${rx},${ry},0,0,1,${x + w - rx},${y + h}H${x + rx}A${rx},${ry},0,0,1,${x},${y + h - ry}` +
                `V${y + ry}A${rx},${ry},0,0,1,${x + rx},${y}Z`
            );
        }
        case "circle":
        case "ellipse": {
            const cx = n("cx");
            const cy = n("cy");
            const rx = tag === "circle" ? n("r") : n("rx");
            const ry = tag === "circle" ? n("r") : n("ry");
            return `M${cx - rx},${cy}A${rx},${ry},0,1,0,${cx + rx},${cy}A${rx},${ry},0,1,0,${cx - rx},${cy}Z`;
        }
        case "line":
            return `M${n("x1")},${n("y1")}L${n("x2")},${n("y2")}`;
        case "polyline":
        case "polygon": {
            const nums = (attrs.points ?? "")
                .trim()
                .split(/[\s,]+/)
                .map(Number);
            if (nums.length < 4) return null;
            let d = `M${nums[0]},${nums[1]}`;
            for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]},${nums[i + 1]}`;
            return tag === "polygon" ? `${d}Z` : d;
        }
        default:
            return null;
    }
}

/** Output precision, in hundredths of a unit: 10 means 1/10 unit. */
const STEP = 10;

/** Integer hundredths of a unit, rounded to STEP. */
const q = (v: number): number => {
    const r = Math.round((v * 100) / STEP) * STEP;
    return Object.is(r, -0) ? 0 : r;
};

function formatNumber(h: number): string {
    const neg = h < 0;
    const abs = Math.abs(h);
    const int = Math.floor(abs / 100);
    const frac = abs % 100;
    let s = frac === 0 ? String(int) : `${int}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
    if (s.startsWith("0.")) s = s.slice(1);
    return neg ? `-${s}` : s;
}

/** Join numbers with the fewest separators: none before "-", none before "." if the previous has a ".". */
function joinNumbers(nums: number[]): string {
    let out = "";
    let prev = "";
    for (const h of nums) {
        const s = formatNumber(h);
        const needsSeparator = prev !== "" && !s.startsWith("-") && !(s.startsWith(".") && prev.includes("."));
        out += (needsSeparator ? "," : "") + s;
        prev = s;
    }
    return out;
}

/**
 * Arcs over 180 degrees become two halves. A near-full circle (Phosphor draws dots as one arc whose end is 0.06
 * units from its start) would otherwise round to equal end points, and an SVG arc with equal end points draws nothing.
 */
function splitLargeArcs(segments: Segment[]): Segment[] {
    return segments.flatMap((s) => {
        if (s.kind !== "A" || Math.abs(s.delta) <= Math.PI * 1.01) return [s];
        const half = s.delta / 2;
        const first = arc(s.centre, s.r, s.start, half);
        const second = arc(s.centre, s.r, s.start + half, half);
        return [
            { ...first, p0: s.p0 },
            { ...second, p0: first.p1, p1: s.p1 },
        ];
    });
}

export function serialisePath(input: Subpath[]): string {
    let out = "";
    const subpaths = input.map((sp) => ({ ...sp, segments: splitLargeArcs(sp.segments) }));
    for (const sp of subpaths) {
        const first = sp.segments[0];
        if (!first) continue;
        let cx = q(first.p0.x);
        let cy = q(first.p0.y);
        const sx = cx;
        const sy = cy;
        out += `M${joinNumbers([cx, cy])}`;
        const segments = sp.segments;
        for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            if (!s) continue;
            const ex = q(s.p1.x);
            const ey = q(s.p1.y);
            const isLast = i === segments.length - 1;
            // A closing line back to the start is implied by Z.
            if (sp.closed && isLast && s.kind === "L" && ex === sx && ey === sy) break;
            let abs = "";
            let rel = "";
            if (s.kind === "L") {
                if (ex === cx && ey === cy) continue;
                if (ey === cy) {
                    abs = `H${joinNumbers([ex])}`;
                    rel = `h${joinNumbers([ex - cx])}`;
                } else if (ex === cx) {
                    abs = `V${joinNumbers([ey])}`;
                    rel = `v${joinNumbers([ey - cy])}`;
                } else {
                    abs = `L${joinNumbers([ex, ey])}`;
                    rel = `l${joinNumbers([ex - cx, ey - cy])}`;
                }
            } else if (s.kind === "C") {
                const c = [q(s.c1.x), q(s.c1.y), q(s.c2.x), q(s.c2.y), ex, ey];
                // A cubic that rounds to a single point draws nothing.
                if (c.every((v, k) => v === (k % 2 === 0 ? cx : cy))) continue;
                abs = `C${joinNumbers(c)}`;
                rel = `c${joinNumbers(c.map((v, k) => v - (k % 2 === 0 ? cx : cy)))}`;
            } else {
                if (ex === cx && ey === cy) continue;
                // Near-semicircles: round the radius down so the renderer scales it to exactly half the chord.
                // Rounding up would turn a cap into a visibly flatter minor arc. The chord is the one between the
                // rounded end points: from the source radius, a ring drawn as two semicircles (r 104, chord 207.89
                // after rounding) got its centre 3.5 units off and thinned from 16 to 12.6 units.
                const semicircle = Math.abs(Math.abs(s.delta) - Math.PI) < 1e-3;
                const halfChord = Math.hypot(ex - cx, ey - cy) / 2;
                const r = semicircle ? Math.floor(Math.min(s.r * 100, halfChord) / STEP) * STEP : q(s.r);
                const large = Math.abs(s.delta) > Math.PI ? 100 : 0;
                const sweep = s.delta > 0 ? 100 : 0;
                // Flags are written as plain 0/1 numbers (hundredths 0 and 100).
                abs = `A${joinNumbers([r, r, 0, large, sweep, ex, ey])}`;
                rel = `a${joinNumbers([r, r, 0, large, sweep, ex - cx, ey - cy])}`;
            }
            out += rel.length <= abs.length ? rel : abs;
            cx = ex;
            cy = ey;
        }
        if (sp.closed) out += "Z";
    }
    return out;
}
