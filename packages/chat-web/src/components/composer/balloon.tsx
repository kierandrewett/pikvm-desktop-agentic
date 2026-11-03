/**
 * Confirmation balloon for client-side slash commands ("/effort high", "/model ...", "/permission full", "/clear").
 *
 * - A small speech balloon with a tail that points at the control the command changed, so the user sees what
 *   changed and where. Controls opt in with `data-balloon-anchor="<kind>"`.
 * - Surface: a TailedSurface with the tooltip tokens (bg, 5% ink hairline, tooltip shadow), body and tail as one
 *   outline. Bold short title, optional muted detail line, small leading icon, close button.
 * - Placement: the preferred side, flipped when there is no room, then shifted to stay 8px inside the viewport. The
 *   tail follows the anchor centre (TailedSurface keeps it on the edge). A frame loop tracks the anchor while the
 *   balloon shows, because the effort trigger animates its width right after a change.
 * - Motion: pops from the tail tip (the surface's transform origin), fades out after 2.5s, and the timer pauses while the pointer is on it. The
 *   anchor pulses a focus-ring halo once. Reduced motion: opacity only, and the halo fades without growing.
 * - A new balloon replaces the previous one (the host is keyed by id).
 * - Screen readers: a persistent polite live region carries the text; the visual balloon is aria-hidden.
 *
 * When the anchor is not visible (for example a control hidden on mobile), the caller falls back to the floating
 * notice. See `findAnchor`.
 */
import { X } from "@pikvm/icons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { appHeight } from "../../lib/app-height";
import { motionEase, motionMs } from "../../lib/motion";
import { reducedMotion } from "../model-picker/motion";
import { TailedSurface } from "../ui/tailed-surface";
import { useThemeLayer } from "../../lib/theme-scope";

export type BalloonAnchor = "effort" | "model" | "permission" | "composer";

export type BalloonData = {
    id: number;
    anchor: BalloonAnchor;
    title: string;
    detail?: string;
    icon: ReactNode;
};

const SHOW_MS = 2500;
const RESUME_MS = 1500;
/** Anchor to body. The "md" tail is 8px long, so its tip stops 2px from the anchor, like a tooltip's. */
const GAP = 10;
const EDGE = 8;

/** Tray controls sit below the composer, so their balloon prefers to open downwards, away from the input. */
const PREFERRED: Record<BalloonAnchor, "top" | "bottom"> = {
    effort: "top",
    composer: "top",
    model: "bottom",
    permission: "bottom",
};

/** The anchor control inside `scope`, or null when it is missing, hidden or outside the viewport. */
export function findAnchor(scope: HTMLElement | null, kind: BalloonAnchor): HTMLElement | null {
    const el = scope?.querySelector<HTMLElement>(`[data-balloon-anchor="${kind}"]`);
    if (!el || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (r.bottom < 0 || r.top > appHeight() || r.right < 0 || r.left > innerWidth) return null;
    return el;
}

type Place = { left: number; top: number; side: "top" | "bottom"; tail: number };

function place(
    anchor: DOMRect,
    input: DOMRect | undefined,
    w: number,
    h: number,
    preferred: "top" | "bottom",
): Place | null {
    const viewport = window.visualViewport;
    const minTop = (viewport?.offsetTop ?? 0) + EDGE;
    const maxBottom = (viewport ? viewport.offsetTop : 0) + appHeight() - EDGE;
    // Whole device pixels, so the outline's hairline stays crisp.
    const snap = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio;
    const cx = anchor.left + anchor.width / 2;
    const left = snap(Math.min(Math.max(EDGE, cx - w / 2), Math.max(EDGE, innerWidth - w - EDGE)));
    const tail = cx - left;
    const sides = [preferred, preferred === "top" ? "bottom" : "top"] as const;
    for (const side of sides) {
        let top = side === "top" ? anchor.top - GAP - h : anchor.bottom + GAP;
        if (input && left < input.right && left + w > input.left && top < input.bottom && top + h > input.top) {
            top = side === "top" ? input.top - GAP - h : input.bottom + GAP;
        }
        if (top >= minTop && top + h <= maxBottom) return { left, top: snap(top), side, tail };
    }
    // Keep the live announcement, but omit the visual balloon when neither side has safe space.
    return null;
}

function pulse(el: HTMLElement) {
    const ring = getComputedStyle(el).getPropertyValue("--ring").trim();
    if (!ring) return;
    const reduced = reducedMotion();
    el.animate(
        reduced
            ? [
                  { boxShadow: `0 0 0 2px ${ring}` },
                  { boxShadow: `0 0 0 2px color-mix(in srgb, ${ring} 0%, transparent)` },
              ]
            : [
                  { boxShadow: `0 0 0 0 ${ring}` },
                  { boxShadow: `0 0 0 5px color-mix(in srgb, ${ring} 0%, transparent)` },
              ],
        { duration: motionMs(reduced ? 900 : 700), easing: motionEase("enter") },
    );
}

/** Keyed by the balloon id by the caller, so each balloon mounts fresh and replaces the last one. */
export function Balloon({
    balloon,
    anchor,
    onDone,
}: {
    balloon: BalloonData;
    anchor: HTMLElement;
    onDone: (id: number) => void;
}) {
    const layer = useThemeLayer();
    const ref = useRef<HTMLDivElement>(null);
    // Motion runs on the surface, whose transform origin is the tail tip; `ref` only positions.
    const surface = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<Place | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const leaving = useRef(false);

    // Track the anchor every frame while shown; only re-render when the placement changes.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        let raf = 0;
        let last = "";
        const tick = () => {
            // The control can unmount under the balloon (a model without effort, a route change).
            if (!anchor.isConnected) return onDone(balloon.id);
            const r = anchor.getBoundingClientRect();
            const input = anchor.closest("[data-composer]")?.querySelector("textarea");
            const p = place(
                r,
                input?.getBoundingClientRect(),
                el.offsetWidth,
                el.offsetHeight,
                PREFERRED[balloon.anchor],
            );
            const k = p ? `${Math.round(p.left)},${Math.round(p.top)},${p.side},${Math.round(p.tail)}` : "hidden";
            if (k !== last) {
                last = k;
                setPos(p);
            }
            raf = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(raf);
    }, [anchor, balloon.anchor, balloon.id, onDone]);

    const leave = () => {
        const el = surface.current;
        if (!el || leaving.current) return;
        leaving.current = true;
        if (motionMs(200) === 0) return onDone(balloon.id);
        const reduced = reducedMotion();
        const a = el.animate(
            reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0, transform: "scale(0.96)" }],
            { duration: motionMs(200), easing: motionEase("exit"), fill: "forwards" },
        );
        a.onfinish = () => onDone(balloon.id);
    };
    const schedule = (ms: number) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(leave, ms);
    };

    // Enter once the first placement is known, so the pop grows from the real tail tip.
    const entered = useRef(false);
    useLayoutEffect(() => {
        const el = surface.current;
        if (!el || !pos || entered.current) return;
        entered.current = true;
        pulse(anchor);
        if (reducedMotion())
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs(150), easing: "linear" });
        else
            el.animate(
                [
                    { opacity: 0, transform: "scale(0.6)" },
                    { opacity: 1, offset: 0.4 },
                    { opacity: 1, transform: "scale(1)" },
                ],
                { duration: motionMs(280), easing: motionEase("enter") },
            );
        // Runs once, on the first placement; `entered` guards later placement updates.
    }, [pos]);

    useEffect(() => {
        schedule(SHOW_MS);
        return () => clearTimeout(timer.current);
    }, []);

    return createPortal(
        <div
            ref={ref}
            aria-hidden
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={() => !leaving.current && schedule(RESUME_MS)}
            style={{
                left: pos?.left ?? -9999,
                top: pos?.top ?? -9999,
                visibility: pos ? undefined : "hidden",
            }}
            className="fixed z-[60] max-w-[min(320px,calc(100vw-16px))] select-none"
        >
            <TailedSurface
                ref={surface}
                side={pos?.side ?? PREFERRED[balloon.anchor]}
                tail={pos?.tail ?? null}
                size="md"
                className="flex items-start gap-2.5 py-2.5 ps-3 pe-2 text-text"
            >
                <span className="flex h-5 shrink-0 items-center text-text [&_svg]:size-5">{balloon.icon}</span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-5 font-semibold">{balloon.title}</span>
                    {balloon.detail && <span className="block text-xs leading-4 text-tertiary">{balloon.detail}</span>}
                </span>
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={leave}
                    className="relative -my-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-tertiary after:absolute after:-inset-1.5 after:content-[''] hover-device:hover:bg-hover hover-device:hover:text-text"
                >
                    <X className="size-3.5" />
                </button>
            </TailedSurface>
        </div>,
        layer ?? document.body,
    );
}

/** Persistent polite live region, so the confirmation is announced even though each balloon mounts fresh. */
export function BalloonAnnouncer({ text }: { text: string }) {
    return (
        <div role="status" aria-live="polite" className="sr-only">
            {text}
        </div>
    );
}
