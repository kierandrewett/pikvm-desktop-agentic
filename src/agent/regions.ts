/**
 * LLM-driven screen region segmentation.
 *
 * While the agent drives the target, a FAST vision model labels the salient UI
 * regions of the live frame — windows, the host taskbar, an embedded AVD, a
 * terminal, a browser, side panels — each with a short label, a category
 * (`kind`) and a bounding box in frame-pixel coordinates. The agent can then
 * reason spatially ("am I on the host taskbar or inside the AVD?"), and the
 * console draws the boxes as a live overlay.
 *
 * Nothing here is hardcoded to a particular app: the model decides what the
 * regions are. The expensive part — the model call — is CHANGE-GATED: we keep
 * the last result cached and only re-segment when a cheap whole-frame grid diff
 * says the layout shifted materially (a new window, an app switch, a resize).
 * A blinking caret or a few typed characters must NOT trigger a recompute, so a
 * stable screen costs ~zero model calls.
 *
 * This module is a pure orchestrator: the model call and the grid capture are
 * injected, so it never imports Electron and is unit-testable. It reuses the
 * `GridSnapshot` primitive from watched typing.
 */

import type { GridSnapshot } from "./watched-typing";

/** A bounding box in the pixels of the captured frame (origin top-left). */
export interface RegionBBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** One labelled region of the screen, in frame-pixel coordinates. */
export interface ScreenRegion {
    /** A short human label, e.g. "Host taskbar", "Terminal - bash", "AVD". */
    label: string;
    /**
     * A coarse category so the agent (and the overlay) can reason by type.
     * Free-form but guided to a small vocabulary (see {@link REGION_KINDS}).
     */
    kind: string;
    bbox: RegionBBox;
}

/** The cached segmentation plus the frame it was computed against. */
export interface RegionsResult {
    regions: ScreenRegion[];
    /** Frame dimensions (px) the bboxes are expressed in. */
    width: number;
    height: number;
    /** When this segmentation was computed (epoch ms). */
    at: number;
}

/**
 * The suggested kind vocabulary handed to the model. It is GUIDANCE, not a hard
 * constraint - the model may emit another short kind if nothing fits - and is
 * deliberately app-agnostic (no "chrome"/"vscode"/... specifics).
 */
export const REGION_KINDS = [
    "taskbar",
    "window",
    "terminal",
    "browser",
    "editor",
    "emulator", // an embedded device emulator such as an Android Virtual Device (AVD)
    "panel", // a docked side/tool panel
    "dialog", // a modal dialog or popup
    "menu", // a menu / context menu / start menu
    "desktop", // bare desktop / wallpaper area
    "system-tray",
    "other",
] as const;

/* --------------------------- change-gate (grid) --------------------------- */

/** A grid cell must shift by more than this (0..255 grey) to count as changed. */
const CELL_DELTA = 22;
/**
 * Fraction of the grid's cells that must change before we treat the layout as
 * materially different and re-segment. Tuned so a blinking caret / a few typed
 * characters (a handful of cells on a 96x54 ~ 5184-cell grid) stays well under
 * the bar, while a new window, an app switch or a resize sails over it.
 */
const RECOMPUTE_FRACTION = 0.06;

/**
 * Has the screen changed materially between two grids? Returns true when too
 * many cells differ (a real layout shift), false for small local changes
 * (caret, typing, a spinner). Also true when the grids are incomparable
 * (different geometry) - better to recompute than to trust a stale layout.
 */
export function gridChangedMaterially(before: GridSnapshot, after: GridSnapshot, fraction = RECOMPUTE_FRACTION): boolean {
    if (before.cols !== after.cols || before.rows !== after.rows) return true;
    const total = after.cols * after.rows;
    if (total === 0) return true;
    let changed = 0;
    for (let i = 0; i < total; i++) {
        if (Math.abs((after.cells[i] ?? 0) - (before.cells[i] ?? 0)) > CELL_DELTA) changed++;
    }
    return changed / total > fraction;
}

/* ------------------------------ validation ------------------------------- */

const MAX_REGIONS = 24;
const MIN_BBOX_PX = 4;

function isFiniteNum(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate + sanitise the model's raw JSON into well-formed regions, clamped to
 * the frame. Anything malformed is dropped rather than throwing - a partial set
 * of good regions is more useful than none, and a model slip must never crash
 * the agent loop.
 */
export function validateRegions(raw: unknown, dims: { width: number; height: number }): ScreenRegion[] {
    const W = Math.max(1, Math.round(dims.width));
    const H = Math.max(1, Math.round(dims.height));
    let list: unknown[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object" && Array.isArray((raw as { regions?: unknown[] }).regions)) {
        list = (raw as { regions: unknown[] }).regions;
    }
    const out: ScreenRegion[] = [];
    for (const item of list) {
        if (out.length >= MAX_REGIONS) break;
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const box = (r.bbox ?? r.box ?? r.bounds) as Record<string, unknown> | undefined;
        if (!box || typeof box !== "object") continue;
        // Accept either {x,y,width,height} or {x,y,w,h}.
        const x = box.x;
        const y = box.y;
        const width = box.width ?? box.w;
        const height = box.height ?? box.h;
        if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(width) || !isFiniteNum(height)) continue;
        // Clamp into the frame; drop degenerate boxes.
        const cx = Math.max(0, Math.min(x, W - 1));
        const cy = Math.max(0, Math.min(y, H - 1));
        const cw = Math.max(0, Math.min(width, W - cx));
        const ch = Math.max(0, Math.min(height, H - cy));
        if (cw < MIN_BBOX_PX || ch < MIN_BBOX_PX) continue;
        const label = String(r.label ?? r.name ?? "").trim().slice(0, 48) || "Region";
        const kind = String(r.kind ?? r.category ?? r.type ?? "other").trim().toLowerCase().slice(0, 24) || "other";
        out.push({
            label,
            kind,
            bbox: { x: Math.round(cx), y: Math.round(cy), width: Math.round(cw), height: Math.round(ch) },
        });
    }
    return out;
}

/* ------------------------------- prompting ------------------------------- */

/** System prompt for the segmenter - strict about output shape + coordinates. */
export const REGIONS_SYSTEM =
    "You segment a screenshot of a desktop computer into its salient, top-level UI regions. " +
    "A region is a visually distinct, meaningful container the user interacts with as a unit: an application WINDOW " +
    "(give one box per visible window, not its inner widgets), the host TASKBAR / dock / start bar, a docked side or tool " +
    "PANEL, a modal DIALOG or popup, an open MENU, the system tray, the bare DESKTOP, and - importantly - any region that is " +
    "ITSELF a nested computer-like surface, such as an embedded device emulator (an Android Virtual Device / AVD), a " +
    "terminal, a browser viewport, or a code editor, because the user can be working INSIDE it. " +
    "Do NOT label tiny controls (individual buttons, icons, fields, tabs) or overlapping duplicates - stay at the level of " +
    "windows and major panels, roughly 3 to 12 regions. Prefer non-overlapping boxes that tightly bound each region. " +
    "Coordinates are in PIXELS of the provided image, origin at the TOP-LEFT, x rightwards and y downwards. " +
    'Reply with ONLY compact JSON of the form {"regions":[{"label":"<=5 words","kind":"<category>","bbox":{"x":int,"y":int,"width":int,"height":int}}]} ' +
    "and nothing else. Use a short lower-case kind from: " +
    REGION_KINDS.join(", ") +
    ' (pick the closest; use "other" if none fit).';

/** Per-frame instruction, carrying the exact image dimensions for the model. */
export function buildRegionsInstruction(dims: { width: number; height: number }): string {
    return (
        `The image is ${Math.round(dims.width)} x ${Math.round(dims.height)} pixels. ` +
        "Segment it into its salient top-level regions now and output only the JSON."
    );
}

/** Parse the model's raw text into validated regions (tolerant of code fences / prose). */
export function parseRegionsResponse(raw: string, dims: { width: number; height: number }): ScreenRegion[] {
    if (!raw) return [];
    // Grab the first JSON object/array in the text (the model may wrap it in prose).
    const obj = raw.match(/\{[\s\S]*\}/);
    const arr = raw.match(/\[[\s\S]*\]/);
    const candidate = obj?.[0] ?? arr?.[0];
    if (!candidate) return [];
    try {
        return validateRegions(JSON.parse(candidate), dims);
    } catch {
        return [];
    }
}

/* ------------------------------ segmenter -------------------------------- */

export interface RegionSegmenterDeps {
    /**
     * Run the FAST vision model over the image with the given system + instruction
     * and return its raw text. (Wired to the runner's `quickLook`.)
     */
    segment(image: { data: string; mimeType: string }, instruction: string, system: string): Promise<string>;
}

/** A frame to segment: the encoded image plus the dimensions its pixels map to. */
export interface SegmentInput {
    image: { data: string; mimeType: string };
    width: number;
    height: number;
}

/**
 * Caches the last segmentation and only recomputes when the grid says the layout
 * changed materially. Concurrent recompute requests coalesce so a burst of
 * screenshots fires at most one model call.
 */
export class RegionSegmenter {
    private cache: RegionsResult | null = null;
    private lastGrid: GridSnapshot | null = null;
    private inflight: Promise<RegionsResult | null> | null = null;

    constructor(
        private readonly deps: RegionSegmenterDeps,
        private readonly opts: { fraction?: number } = {},
    ) {}

    /** The current cached regions (or null if never computed). Never blocks. */
    getRegions(): RegionsResult | null {
        return this.cache;
    }

    /** Drop the cache (e.g. on session change) so the next tick recomputes. */
    reset(): void {
        this.cache = null;
        this.lastGrid = null;
    }

    /**
     * Decide whether a recompute is warranted, given the latest grid. True when
     * there is no cache yet, or the grid changed materially vs the grid the cache
     * was computed against.
     */
    shouldRecompute(grid: GridSnapshot | null): boolean {
        if (!this.cache) return true;
        if (!grid || !this.lastGrid) return false; // no grid signal => trust the cache
        return gridChangedMaterially(this.lastGrid, grid, this.opts.fraction);
    }

    /**
     * Opportunistically re-segment IF the change-gate says the layout shifted.
     * Returns the (possibly unchanged) cached result, or null if a first
     * computation failed. Coalesces concurrent calls. Never throws.
     */
    async maybeRecompute(input: SegmentInput, grid: GridSnapshot | null): Promise<RegionsResult | null> {
        if (!this.shouldRecompute(grid)) return this.cache;
        if (this.inflight) return this.inflight;
        this.inflight = this.compute(input, grid).finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    private async compute(input: SegmentInput, grid: GridSnapshot | null): Promise<RegionsResult | null> {
        const dims = { width: input.width, height: input.height };
        try {
            const raw = await this.deps.segment(input.image, buildRegionsInstruction(dims), REGIONS_SYSTEM);
            const regions = parseRegionsResponse(raw, dims);
            // Only adopt + cache a non-empty result; an empty parse keeps the prior
            // (still-plausible) regions rather than blanking the overlay on a glitch.
            if (regions.length) {
                this.cache = { regions, width: input.width, height: input.height, at: Date.now() };
                if (grid) this.lastGrid = grid;
            } else if (grid && this.cache) {
                // Re-baseline the grid so we don't thrash on a model that returned
                // nothing for a frame we've already accepted as the current layout.
                this.lastGrid = grid;
            }
            return this.cache;
        } catch {
            return this.cache;
        }
    }
}
