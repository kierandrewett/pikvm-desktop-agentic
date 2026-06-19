/**
 * WindMouse human-mouse path generator.
 *
 * A faithful port of the `windmouse` model from ~/dev/mouse-random/engine.js
 * (ben.land's WindMouse gravity+wind force integration, plus the shared
 * speed-scaled jitter / endpoint-scatter / bursty-timing post-processing that
 * the engine applies to the WindMouse branch).
 *
 * The force constants (gravity, wind, maxStep, the D0=12 transition distance)
 * are tuned for PIXEL-scale coordinates, so callers must run this in pixel space
 * and convert the resulting points into whatever the device wants. Output is a
 * list of {x, y, t} samples where `t` is an absolute millisecond timestamp.
 */

export interface Pt {
    x: number;
    y: number;
}

export interface WindMouseSample extends Pt {
    /** Absolute time of this sample, in milliseconds from the start of the move. */
    t: number;
}

export interface WindMouseOptions {
    /** Higher is faster (shorter duration). The user-requested default is 1.9. */
    speed?: number;
    /** WindMouse gravity (pull toward the target). */
    gravity?: number;
    /** WindMouse wind (random walk magnitude). */
    wind?: number;
    /** WindMouse maximum per-step velocity. */
    maxStep?: number;
    /** Sample rate the bursty timing is built around. */
    hz?: number;
    /** Perpendicular tremor amplitude (0 disables the extra jitter). */
    tremor?: number;
    /** Std-dev of the off-centre landing scatter, in pixels. */
    endScatter?: number;
    /** Hesitation rate (chance of a small mid-move pause). */
    hes?: number;
    /** Per-step dt jitter fraction. */
    dtjit?: number;
    /** Seeded/!injectable RNG in [0,1); defaults to Math.random. */
    rng?: () => number;
}

const DEFAULTS: Required<Omit<WindMouseOptions, "rng">> = {
    speed: 1.9,
    gravity: 9,
    wind: 3,
    maxStep: 15,
    hz: 120,
    tremor: 0.5,
    endScatter: 2,
    hes: 0.04,
    dtjit: 0.3,
};

/** Box-Muller standard normal. */
function gauss(rng: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * WindMouse force integration. Returns the raw geometric path (pixel points)
 * from `start` to `end`. This is the algorithm itself; jitter/timing is layered
 * on top in {@link windMousePath}.
 */
function windMouseGeometry(start: Pt, end: Pt, o: Required<Omit<WindMouseOptions, "rng">>, rng: () => number): Pt[] {
    const sqrt3 = Math.sqrt(3);
    const sqrt5 = Math.sqrt(5);
    const G = o.gravity;
    const W = o.wind;
    const D0 = 12;
    let M = o.maxStep;
    let cx = start.x;
    let cy = start.y;
    let vx = 0;
    let vy = 0;
    let wx = 0;
    let wy = 0;
    const pts: Pt[] = [{ x: cx, y: cy }];
    let guard = 0;
    while (true) {
        const dx = end.x - cx;
        const dy = end.y - cy;
        const d = Math.hypot(dx, dy);
        if (d < 1) break;
        const Wm = Math.min(W, d);
        if (d >= D0) {
            wx = wx / sqrt3 + (2 * rng() - 1) * Wm / sqrt5;
            wy = wy / sqrt3 + (2 * rng() - 1) * Wm / sqrt5;
        } else {
            wx /= sqrt3;
            wy /= sqrt3;
            if (M < 3) M = 3 + rng() * 3;
            else M /= sqrt5;
        }
        vx += wx + (G * dx) / d;
        vy += wy + (G * dy) / d;
        const vmag = Math.hypot(vx, vy);
        if (vmag > M) {
            const vc = M / 2 + (rng() * M) / 2;
            vx = (vx / vmag) * vc;
            vy = (vy / vmag) * vc;
        }
        cx += vx;
        cy += vy;
        pts.push({ x: cx, y: cy });
        if (++guard > 8000) break;
    }
    pts.push({ x: end.x, y: end.y });
    return pts;
}

/**
 * Generate a full WindMouse move: geometry + speed-scaled perpendicular jitter +
 * endpoint scatter + bursty, duration-preserving timestamps. Duration follows
 * Fitts's law scaled by `speed`.
 */
export function windMousePath(start: Pt, end: Pt, optsIn: WindMouseOptions = {}): WindMouseSample[] {
    const o = { ...DEFAULTS, ...optsIn };
    const rng = optsIn.rng ?? Math.random;
    const D = Math.hypot(end.x - start.x, end.y - start.y);
    if (D < 1) return [{ x: start.x, y: start.y, t: 0 }];

    // Fitts's law: total duration from distance + a virtual target width.
    const W = 12;
    const ID = Math.log2(D / W + 1);
    let dur = (120 + 200 * ID) / o.speed;
    dur *= 1 + gauss(rng) * 0.08;
    dur = Math.max(70, dur);

    const geo = windMouseGeometry(start, end, o, rng);
    const raw = geo.map((p, i) => ({ x: p.x, y: p.y, f: i / (geo.length - 1) }));

    // Broadband perpendicular jitter, amplitude coupled to local speed (the
    // WindMouse branch uses a 0.6 multiplier so it stays subtle).
    const steps = raw.map((p, i) => {
        const prev = raw[i - 1];
        return prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
    });
    const maxStep = Math.max.apply(null, steps) || 1;
    const samples: WindMouseSample[] = [];
    let lf = 0;
    for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        if (!r) continue;
        const spd = (steps[i] ?? 0) / maxStep;
        let nx = 0;
        let ny = 0;
        const prev = raw[i - 1];
        if (prev) {
            const ddx = r.x - prev.x;
            const ddy = r.y - prev.y;
            const dl = Math.hypot(ddx, ddy) || 1;
            nx = -ddy / dl;
            ny = ddx / dl;
        }
        lf = lf * 0.6 + gauss(rng) * 0.4;
        const hf = gauss(rng);
        const amp = o.tremor * (0.15 + spd) * 0.6;
        const perp = (hf * 0.3 + lf * 1.0) * amp;
        samples.push({ x: r.x + nx * perp, y: r.y + ny * perp, t: 0 });
    }

    // Endpoint scatter: blend an off-centre landing across the final approach.
    if (samples.length > 3) {
        const ox = gauss(rng) * o.endScatter;
        const oy = gauss(rng) * o.endScatter;
        const K = Math.max(2, Math.round(samples.length * 0.12));
        for (let i = samples.length - K; i < samples.length; i++) {
            const s = samples[i];
            if (!s) continue;
            const w = (i - (samples.length - K)) / (K - 1 || 1);
            s.x += ox * w;
            s.y += oy * w;
        }
        const last = samples[samples.length - 1];
        if (last) {
            last.x = end.x + ox;
            last.y = end.y + oy;
        }
    }

    // Bursty, duration-preserving timestamps (matches a real dt distribution:
    // ~6% coalesced bursts, occasional hesitations, bulk near the poll interval).
    const dtBase = 1000 / o.hz;
    const rawDt = [0];
    for (let i = 1; i < samples.length; i++) {
        const roll = rng();
        let dt: number;
        if (roll < 0.06) dt = rng() * 1.5;
        else if (roll < 0.06 + o.hes * 0.3) dt = 25 + rng() * 110;
        else dt = dtBase * (1 + (rng() * 2 - 1) * o.dtjit);
        rawDt.push(dt);
    }
    const sumDt = rawDt.reduce((a, b) => a + b, 0) || 1;
    const scale = dur / sumDt;
    let tAbs = 0;
    for (let i = 0; i < samples.length; i++) {
        tAbs += (rawDt[i] ?? 0) * scale;
        const s = samples[i];
        if (s) s.t = tAbs;
    }
    return samples;
}
