/**
 * ChatCompose: the "New chat" glyph. A rounded square open at the top-right corner, with a stylus that enters
 * through the opening and writes towards the centre. Drawn for this package (not traced from any product).
 *
 * Geometry, on the 256 grid, in centre-line terms (stroke 16 regular, 24 bold):
 * - Frame: square with centre lines x 36..204, y 48..216 (outer 28..212 x 40..224, the size of the other framed
 *   icons). The top edge stops at x 112 and the right edge at y 140, with round caps.
 * - Stylus axis: x + y = 252, the anti-diagonal through the square's centre (120, 132) and its open corner
 *   (204, 48). Both frame ends are 65 units from the axis, so the space round the stylus is even on both sides.
 * - Stylus: solid, sharp tip at (94, 158), round end at (212, 40), half-width 14 (17 bold, 16 fill). A solid
 *   stylus is the focal point and stays legible at 16 px, where an outlined pencil's inner hole closes up.
 * - Fill: a solid tile (the regular frame's outer bounds) with a notch cut 14 units round the stylus.
 *
 * The build rounds these outlines with the same rules as every Phosphor icon (scripts/smooth.ts), so the frame
 * corners match the rest of the set. VARIANTS are the candidates that were compared; the preview shows them.
 */
import { type Point, along, polygonPath, strokePath } from "./stroke.ts";
import type { CustomIcon } from "./index.ts";

const STROKE = { regular: 16, bold: 24 } as const;
const TIP: Point = [94, 158];
const END: Point = [212, 40];
const TILE_MIN: Point = [28, 40];
const TILE_MAX: Point = [212, 224];

/** Open frame: top edge from `topEnd` to the left, down, along the bottom, up the right side to `rightEnd`. */
function frame(width: number, topEnd = 112, rightEnd = 140): string {
    return strokePath(
        [
            [topEnd, 48],
            [36, 48],
            [36, 216],
            [204, 216],
            [204, rightEnd],
        ],
        width,
    );
}

/** Speech bubble: the frame with a tail at the bottom-left corner. */
function bubble(width: number): string {
    return strokePath(
        [
            [112, 48],
            [36, 48],
            [36, 228],
            [80, 202],
            [204, 202],
            [204, 140],
        ],
        width,
    );
}

const fmt = (p: Point): string => `${Math.round(p[0] * 100) / 100},${Math.round(p[1] * 100) / 100}`;

/** Solid stylus: sharp tip, body of half-width `hw`, round (or flat) end. */
function stylus(hw: number, tip: number, roundEnd = true): string {
    const len = Math.hypot(END[0] - TIP[0], END[1] - TIP[1]);
    const t = tip / len;
    const a = along(TIP, END, t, hw);
    const b = along(TIP, END, 1, hw);
    const c = along(TIP, END, 1, -hw);
    const d = along(TIP, END, t, -hw);
    const end = roundEnd ? `A${hw},${hw},0,0,0,${fmt(c)}` : `L${fmt(c)}`;
    return `M${fmt(TIP)}L${fmt(a)}L${fmt(b)}${end}L${fmt(d)}Z`;
}

/** Outlined pencil: the stylus's pentagon drawn as a stroke. */
function pencil(width: number, hw: number, tip: number): string {
    const len = Math.hypot(END[0] - TIP[0], END[1] - TIP[1]);
    const t = tip / len;
    return strokePath(
        [TIP, along(TIP, END, t, hw), along(TIP, END, 1, hw), along(TIP, END, 1, -hw), along(TIP, END, t, -hw)],
        width,
        true,
    );
}

/**
 * Solid tile with a notch round the stylus. The notch is the stylus outline grown by `moat`: its sides are
 * hw + moat from the axis and its point is the tip pushed back by moat / sin(tip half-angle), so the gap is even.
 * `rest` are the tile's corners after the notch, clockwise (the bottom of a square, or a bubble with its tail).
 */
function notchedTile(hw: number, tip: number, moat: number, rest: Point[]): string {
    const len = Math.hypot(END[0] - TIP[0], END[1] - TIP[1]);
    const dx = (END[0] - TIP[0]) / len;
    const dy = (END[1] - TIP[1]) / len;
    // Normal towards the lower right.
    const nx = -dy;
    const ny = dx;
    const back = moat / (hw / Math.hypot(hw, tip));
    const apex: Point = [TIP[0] - dx * back, TIP[1] - dy * back];
    const reach = (hw + moat) / (hw / tip);
    const shoulder = (side: number): Point => [
        apex[0] + dx * reach + nx * side * (hw + moat),
        apex[1] + dy * reach + ny * side * (hw + moat),
    ];
    const upper = shoulder(-1);
    const lower = shoulder(1);
    // The notch's sides run on along the axis until they leave the tile: the upper one through the top edge,
    // the lower one through the right edge.
    const topHit: Point = [upper[0] + ((TILE_MIN[1] - upper[1]) / dy) * dx, TILE_MIN[1]];
    const rightHit: Point = [TILE_MAX[0], lower[1] + ((TILE_MAX[0] - lower[0]) / dx) * dy];
    return polygonPath([TILE_MIN, topHit, upper, apex, lower, rightHit, ...rest]);
}

const SQUARE_REST: Point[] = [
    [TILE_MAX[0], TILE_MAX[1]],
    [TILE_MIN[0], TILE_MAX[1]],
];
const BUBBLE_REST: Point[] = [
    [TILE_MAX[0], 210],
    [84, 210],
    [28, 243],
];

export const chatCompose: CustomIcon = {
    name: "ChatCompose",
    paths: {
        regular: [frame(STROKE.regular) + stylus(14, 36)],
        bold: [frame(STROKE.bold) + stylus(17, 38)],
        fill: [notchedTile(16, 38, 14, SQUARE_REST) + stylus(16, 38)],
    },
};

/** Candidates compared in the preview, chosen one first. See README "Custom icons" for the comparison. */
export const VARIANTS: readonly CustomIcon[] = [
    { ...chatCompose, name: "Stylus (chosen)" },
    {
        name: "Outlined pencil",
        paths: {
            regular: [frame(STROKE.regular) + pencil(STROKE.regular, 16, 40)],
            bold: [frame(STROKE.bold) + pencil(STROKE.bold, 18, 42)],
            fill: [notchedTile(16, 38, 14, SQUARE_REST) + stylus(16, 38, false)],
        },
    },
    {
        name: "Bubble",
        paths: {
            regular: [bubble(STROKE.regular) + stylus(14, 36)],
            bold: [bubble(STROKE.bold) + stylus(17, 38)],
            fill: [notchedTile(16, 38, 14, BUBBLE_REST) + stylus(16, 38)],
        },
    },
    {
        name: "Wide opening",
        paths: {
            regular: [frame(STROKE.regular, 100, 152) + stylus(14, 36)],
            bold: [frame(STROKE.bold, 100, 152) + stylus(17, 38)],
            fill: [notchedTile(16, 38, 20, SQUARE_REST) + stylus(16, 38)],
        },
    },
];
