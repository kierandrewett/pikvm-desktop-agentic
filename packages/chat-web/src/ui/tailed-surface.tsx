/**
 * TailedSurface: a rounded surface with a tail that points at its anchor, drawn as ONE outline.
 *
 * Tooltips, composer balloons, the chat hover card and the Radix popouts (through TailedContent, tailed-content.tsx)
 * use it. The body and the tail are a single SVG path, built from the measured box,
 * the corner radius and the tail position. The fill, the 1px hairline and the drop shadow all follow that one
 * outline, so there is no seam where the tail meets the body, no second shadow and no shadow cut off at the tail.
 *
 * - Fill: the path, filled with --tailed-surface-bg.
 * - Hairline: the same path stroked 2px and clipped to itself, so 1px shows on the inside, like a CSS border.
 * - Shadow: `filter: drop-shadow()` on the SVG, converted from the box-shadow token in --tailed-surface-shadow.
 * - Backdrop: a translucent surface sets --tailed-surface-backdrop (a backdrop-filter value, default none). A layer
 *   under the outline applies it, clipped to the same path (clip-path: path()), so the blur covers the tail too.
 * - Corners: --tailed-surface-radius (scales with --roundness), clamped to half the shorter side like CSS. When the
 *   tail sits near a corner, that corner tightens so the tail still points at the anchor.
 * - Motion: the root's transform-origin is the tail tip, so a scale animation on the root grows from the tail.
 * - Forced colours: Canvas fill, CanvasText hairline, no shadow (tailed-surface.css).
 *
 * The path redraws when the box resizes (ResizeObserver) and when side, tail or size change. Edges snap to device
 * pixels, so the hairline stays crisp at 1x and 2x.
 */
import { useId, useImperativeHandle, useLayoutEffect, useRef, type ComponentPropsWithRef } from "react";
import { cn } from "./lib/cn";
import "./tailed-surface.css";

/** Side of the anchor the surface sits on (Radix semantics). The tail is on the opposite edge. */
export type TailSide = "top" | "right" | "bottom" | "left";
export type TailSize = "sm" | "md";

/** Tail base width and length, in px. "sm" for tooltips, "md" for balloons. */
export const TAIL_SIZE: Record<TailSize, { width: number; height: number }> = {
    sm: { width: 14, height: 6 },
    md: { width: 18, height: 8 },
};

export type TailedSurfaceProps = ComponentPropsWithRef<"div"> & {
    side: TailSide;
    /**
     * Tail centre along the tailed edge, in px from the surface's left edge (side top or bottom) or top edge (side
     * left or right). Null draws no tail. Values past the ends are clamped so the whole tail base stays on the edge.
     */
    tail: number | null;
    size?: TailSize;
};

export function TailedSurface({ side, tail, size = "sm", className, children, ref, ...rest }: TailedSurfaceProps) {
    const root = useRef<HTMLDivElement>(null);
    const shape = useRef<SVGSVGElement>(null);
    const backdrop = useRef<HTMLDivElement>(null);
    const clip = `tailed-${useId().replace(/[^\w-]/g, "")}`;
    useImperativeHandle(ref, () => root.current as HTMLDivElement, []);

    useLayoutEffect(() => {
        const el = root.current;
        const svg = shape.current;
        const blur = backdrop.current;
        if (!el || !svg || !blur) return;
        const draw = () => paint(el, svg, blur, side, tail, TAIL_SIZE[size]);
        draw();
        const observer = new ResizeObserver(draw);
        observer.observe(el);
        return () => observer.disconnect();
    }, [side, tail, size]);

    return (
        <div ref={root} data-tail-side={side} className={cn("tailed-surface", className)} {...rest}>
            <div ref={backdrop} className="tailed-surface-backdrop" aria-hidden="true" />
            <svg ref={shape} className="tailed-surface-shape" aria-hidden="true" focusable="false">
                <defs>
                    <clipPath id={clip}>
                        <path />
                    </clipPath>
                </defs>
                <path className="tailed-surface-fill" />
                <path className="tailed-surface-edge" clipPath={`url(#${clip})`} />
            </svg>
            {children}
        </div>
    );
}

/**
 * Measure the root and write the outline, shadow, backdrop clip and transform origin. Imperative, so the first paint
 * has a shape.
 */
function paint(
    el: HTMLElement,
    svg: SVGSVGElement,
    backdrop: HTMLElement,
    side: TailSide,
    tail: number | null,
    size: Tail,
) {
    const cs = getComputedStyle(el);
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const w = snap(Number.parseFloat(cs.width) || 0);
    const h = snap(Number.parseFloat(cs.height) || 0);
    const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
    const { d, tip } = outline(w, h, radius, side, tail, size);
    for (const path of svg.querySelectorAll("path")) path.setAttribute("d", d);
    svg.style.filter = dropShadow(cs.getPropertyValue("--tailed-surface-shadow"));
    // A backdrop-filter only covers its own box, so the layer reaches out by the tail length on every side and the
    // same outline, moved by that much, clips it.
    backdrop.style.inset = `${-size.height}px`;
    backdrop.style.clipPath = `path("${outline(w, h, radius, side, tail, size, size.height).d}")`;
    el.style.transformOrigin = `${tip[0]}px ${tip[1]}px`;
}

type Tail = { width: number; height: number };
type Point = [x: number, y: number];

/** Cubic handle length for a quarter circle. CSS radii are true arcs; this stays within 0.03% of one. */
const K = 0.5523;
/** Tail curve handles, as fractions of the tail width: the base flares into the edge, the tip is rounded. */
const BASE = 0.3;
const TIP = 0.1;

/**
 * Outline of a w x h box with corner radius `radius` and an optional tail, as SVG path data in the box's own px.
 *
 * Built in one frame (tail on the bottom edge, pointing down: a surface above its anchor), then mapped onto the
 * requested side, so all four sides share one construction. Corners are cubics, not arcs, because the mapping
 * mirrors some sides and arc sweep flags do not survive a mirror.
 *
 * Returns the path and the tail tip (the box's anchor-facing edge centre when there is no tail). `shift` moves the
 * path data (not the tip) right and down by that many px, for a layer that starts outside the box.
 */
function outline(
    w: number,
    h: number,
    radius: number,
    side: TailSide,
    tail: number | null,
    size: Tail,
    shift = 0,
): { d: string; tip: Point } {
    const across = side === "left" || side === "right";
    // In the frame, W runs along the tailed edge and H away from it.
    const W = across ? h : w;
    const H = across ? w : h;
    const map = ([x, y]: Point): Point =>
        side === "top" ? [x, y] : side === "bottom" ? [x, H - y] : side === "left" ? [y, x] : [H - y, x];

    const r = Math.max(0, Math.min(radius, W / 2, H / 2));
    const tw = Math.min(size.width, W);
    const th = size.height;
    const c = tail === null ? W / 2 : Math.min(Math.max(tail, tw / 2), W - tw / 2);
    // The two corners on the tailed edge give way to the tail base when it sits near them.
    const rl = tail === null ? r : Math.min(r, c - tw / 2);
    const rr = tail === null ? r : Math.min(r, W - c - tw / 2);

    const parts: string[] = [];
    const pt = (p: Point) =>
        map(p)
            .map((v) => fmt(v + shift))
            .join(" ");
    const move = (p: Point) => parts.push(`M${pt(p)}`);
    const line = (p: Point) => parts.push(`L${pt(p)}`);
    const curve = (a: Point, b: Point, p: Point) => parts.push(`C${pt(a)} ${pt(b)} ${pt(p)}`);

    move([r, 0]);
    line([W - r, 0]);
    curve([W - r + K * r, 0], [W, r - K * r], [W, r]);
    line([W, H - rr]);
    curve([W, H - rr + K * rr], [W - rr + K * rr, H], [W - rr, H]);
    if (tail !== null) {
        line([c + tw / 2, H]);
        curve([c + tw / 2 - BASE * tw, H], [c + TIP * tw, H + th], [c, H + th]);
        curve([c - TIP * tw, H + th], [c - tw / 2 + BASE * tw, H], [c - tw / 2, H]);
    }
    line([rl, H]);
    curve([rl - K * rl, H], [0, H - rl + K * rl], [0, H - rl]);
    line([0, r]);
    curve([0, r - K * r], [r - K * r, 0], [r, 0]);
    parts.push("Z");

    return { d: parts.join(""), tip: map([c, tail === null ? H : H + th]) };
}

function fmt(v: number): string {
    return String(Math.round(v * 100) / 100);
}

/**
 * A box-shadow value as a drop-shadow() filter chain, so the shadow tokens stay the one source for both.
 *
 * A drop-shadow blur is a Gaussian standard deviation, half a box-shadow blur radius: measured in Chrome 155,
 * drop-shadow(0 8px 9px) renders exactly as box-shadow 0 8px 18px (and the spec says the same). Inset layers and
 * 0-offset rings have no drop-shadow form (the hairline draws the edge), so they are skipped; other spreads are
 * dropped.
 */
function dropShadow(value: string): string {
    const filters: string[] = [];
    for (const layer of split(value, ",")) {
        const words = split(layer.replace(/\s+/g, " "), " ");
        if (!words.length || words.includes("inset")) continue;
        const lengths = words.filter((w) => /^-?(\d*\.)?\d+(px)?$/.test(w)).map((w) => Number.parseFloat(w));
        const color = words.filter((w) => !/^-?(\d*\.)?\d+(px)?$/.test(w)).join(" ");
        const [x = 0, y = 0, blur = 0] = lengths;
        if (lengths.length < 2 || (x === 0 && y === 0 && blur === 0)) continue;
        filters.push(`drop-shadow(${x}px ${y}px ${blur / 2}px${color ? ` ${color}` : ""})`);
    }
    return filters.join(" ") || "none";
}

/** Split on a separator outside parentheses, dropping empty parts. */
function split(value: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === sep && depth === 0) {
            out.push(value.slice(start, i));
            start = i + 1;
        }
    }
    out.push(value.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
}
