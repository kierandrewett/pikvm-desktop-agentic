// Smoke test for LLM-driven region segmentation (src/agent/regions.ts). Pure
// logic, no Electron — exercises the change-gate, JSON validation/clamping, the
// response parser, and the RegionSegmenter cache/coalesce behaviour with a fake
// model.
//   esbuild scripts/regions-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/regions-test.cjs && node dist/regions-test.cjs

import {
    gridChangedMaterially,
    validateRegions,
    parseRegionsResponse,
    RegionSegmenter,
    type SegmentInput,
} from "../src/agent/regions";
import type { GridSnapshot } from "../src/agent/watched-typing";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

const COLS = 96;
const ROWS = 54;
const dims = { width: 1920, height: 1080 };

function grid(v = 30): GridSnapshot {
    return { cols: COLS, rows: ROWS, cells: new Uint8Array(COLS * ROWS).fill(v) };
}
/** Flip the first `n` cells to a bright value (simulating changed pixels). */
function withChanged(base: GridSnapshot, n: number, v = 230): GridSnapshot {
    const cells = Uint8Array.from(base.cells);
    for (let i = 0; i < n && i < cells.length; i++) cells[i] = v;
    return { cols: COLS, rows: ROWS, cells };
}

// 1. change-gate -----------------------------------------------------------
{
    const base = grid();
    check("gate: identical grids → no material change", gridChangedMaterially(base, grid()) === false);
    // A blinking caret / a few typed chars = a handful of cells: must NOT trip the gate.
    check("gate: tiny local change (caret/typing) → no recompute", gridChangedMaterially(base, withChanged(base, 40)) === false);
    // A new window / app switch = a large fraction of the grid: must trip it.
    check("gate: large layout change (new window) → recompute", gridChangedMaterially(base, withChanged(base, COLS * ROWS)) === true);
    // Different geometry is incomparable → recompute rather than trust a stale map.
    const odd: GridSnapshot = { cols: 10, rows: 10, cells: new Uint8Array(100) };
    check("gate: incomparable geometry → recompute", gridChangedMaterially(base, odd) === true);
}

// 2. validateRegions -------------------------------------------------------
{
    const ok = validateRegions(
        { regions: [{ label: "Host taskbar", kind: "Taskbar", bbox: { x: 0, y: 1040, width: 1920, height: 40 } }] },
        dims,
    );
    check("validate: accepts a well-formed region", ok.length === 1, ok);
    check("validate: lower-cases the kind", ok[0]?.kind === "taskbar", ok[0]);

    // Bare array form + {x,y,w,h} alias.
    const alias = validateRegions([{ label: "AVD", kind: "emulator", bbox: { x: 100, y: 100, w: 300, h: 600 } }], dims);
    check("validate: accepts bare-array + w/h alias", alias.length === 1 && alias[0]?.bbox.width === 300, alias);

    // Out-of-frame box gets clamped into the frame.
    const clamped = validateRegions([{ label: "x", kind: "window", bbox: { x: -50, y: -10, width: 5000, height: 5000 } }], dims);
    check("validate: clamps to the frame", clamped.length === 1 && clamped[0]!.bbox.x === 0 && clamped[0]!.bbox.width === dims.width, clamped);

    // Degenerate / malformed entries are dropped, not thrown.
    const dropped = validateRegions(
        { regions: [{ label: "tiny", kind: "window", bbox: { x: 5, y: 5, width: 1, height: 1 } }, { nope: true }, 42, { bbox: { x: "a" } }] },
        dims,
    );
    check("validate: drops degenerate/malformed entries", dropped.length === 0, dropped);

    check("validate: non-object input → []", validateRegions(null, dims).length === 0);
    check("validate: missing label defaults to 'Region'", validateRegions([{ kind: "window", bbox: { x: 0, y: 0, width: 50, height: 50 } }], dims)[0]?.label === "Region");
}

// 3. parseRegionsResponse --------------------------------------------------
{
    const fenced = '```json\n{"regions":[{"label":"Terminal","kind":"terminal","bbox":{"x":10,"y":10,"width":400,"height":300}}]}\n```';
    const p = parseRegionsResponse(fenced, dims);
    check("parse: tolerates code fences / prose wrapping", p.length === 1 && p[0]?.kind === "terminal", p);
    check("parse: empty/garbage text → []", parseRegionsResponse("no json here", dims).length === 0);
    check("parse: empty string → []", parseRegionsResponse("", dims).length === 0);
}

// 4. RegionSegmenter cache / change-gate / coalesce ------------------------
async function segmenter(): Promise<void> {
    const input: SegmentInput = { image: { data: "x", mimeType: "image/jpeg" }, width: dims.width, height: dims.height };
    const good = '{"regions":[{"label":"Window","kind":"window","bbox":{"x":0,"y":0,"width":800,"height":600}}]}';

    // First tick (no cache) always computes.
    {
        let calls = 0;
        const seg = new RegionSegmenter({
            segment: async () => {
                calls++;
                return good;
            },
        });
        check("seg: shouldRecompute true with no cache", seg.shouldRecompute(grid()) === true);
        const g0 = grid();
        const r0 = await seg.maybeRecompute(input, g0);
        check("seg: first compute caches a region", !!r0 && r0.regions.length === 1, r0);
        check("seg: getRegions returns the cache", seg.getRegions() === r0);
        check("seg: one model call so far", calls === 1, calls);

        // A stable screen (same grid) costs zero further model calls.
        await seg.maybeRecompute(input, g0);
        check("seg: stable screen → no extra model call", calls === 1, calls);

        // A material layout change re-segments.
        await seg.maybeRecompute(input, withChanged(g0, COLS * ROWS));
        check("seg: material change → re-segments", calls === 2, calls);
    }

    // Coalescing: a burst while one call is in flight fires at most one call.
    {
        let calls = 0;
        let release: (() => void) | null = null;
        const seg = new RegionSegmenter({
            segment: async () => {
                calls++;
                await new Promise<void>((r) => (release = r));
                return good;
            },
        });
        const a = seg.maybeRecompute(input, null);
        const b = seg.maybeRecompute(input, null);
        release?.();
        const [ra, rb] = await Promise.all([a, b]);
        // The real invariant: a burst while a call is in flight fires the model ONCE
        // and both callers see the same resolved result.
        check("seg: coalesced burst = one model call", calls === 1, calls);
        check("seg: coalesced callers get the same result", ra === rb && !!ra, [ra, rb]);
    }

    // An empty/garbage model result keeps the previous (still-plausible) cache.
    {
        let reply = good;
        const seg = new RegionSegmenter({ segment: async () => reply });
        const g0 = grid();
        const first = await seg.maybeRecompute(input, g0);
        check("seg: seeds a cache", !!first);
        reply = "garbage, no json";
        await seg.maybeRecompute(input, withChanged(g0, COLS * ROWS));
        check("seg: empty parse keeps the previous regions", seg.getRegions() === first, seg.getRegions());
    }

    // reset() drops the cache so the next tick recomputes.
    {
        const seg = new RegionSegmenter({ segment: async () => good });
        await seg.maybeRecompute(input, grid());
        check("seg: has a cache before reset", !!seg.getRegions());
        seg.reset();
        check("seg: reset clears the cache", seg.getRegions() === null);
        check("seg: shouldRecompute true after reset", seg.shouldRecompute(grid()) === true);
    }
}

async function main(): Promise<void> {
    console.log("regions smoke test");
    await segmenter();
    if (failed) {
        console.error(`\n${failed} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nall checks passed");
}

void main();
