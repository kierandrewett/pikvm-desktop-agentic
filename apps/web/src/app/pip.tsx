/**
 * The live screen, floating over Chat and Settings: a window on a wide screen, a round bubble on a phone. It is a
 * passive view of the picture the KVM tab already holds (a canvas that copies its frames), so it opens no stream and
 * no input socket of its own and sends nothing to the target. Tap or press Enter to go to the KVM; drag to move it,
 * let go and a spring pulls it to the nearest corner, the one a throw points at (pip-physics.ts); Shift+arrow keys nudge it for a keyboard.
 *
 * It sits inside the content area, so it never covers the tab bar, and its first place is the top right, away from the
 * composer. A person can hide it for this visit with the close button.
 */

import { useNavigate } from "@tanstack/react-router";
import { agentHoldsInput } from "@pikvm/contracts/api";
import { Monitor, X } from "@pikvm/icons";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from "react";
import { useAgentActivity } from "../agent/activity";
import {
    cornerFor,
    keepInside,
    step,
    velocityOf,
    type Area,
    type Body,
    type Sample,
} from "./pip-physics";
import "./pip.css";

const BUBBLE = 84;
const WINDOW_WIDTH = 248;
const MARGIN = 10;
/** A press that moves less than this is a tap, not a drag. */
const DRAG_SLOP = 6;
const NUDGE = 32;
/** The copy of the picture is redrawn no more often than this. */
const DRAW_EVERY_MS = 66;

/** The picture the KVM tab is showing, if it has a frame: the stream's video while it plays, else the still image. */
function pictureSource(): HTMLImageElement | HTMLVideoElement | undefined {
    const pane = document.querySelector<HTMLElement>(".kvm-pane.has-frame");
    if (!pane) return undefined;
    const video = pane.querySelector<HTMLVideoElement>("video.kvm-video");
    if (video && !video.classList.contains("hidden") && video.videoWidth > 0)
        return video;
    const img = pane.querySelector<HTMLImageElement>("img.kvm-img");
    return img && img.naturalWidth > 0 ? img : undefined;
}

const sizeOf = (
    source: HTMLImageElement | HTMLVideoElement,
): { w: number; h: number } =>
    source instanceof HTMLVideoElement
        ? { w: source.videoWidth, h: source.videoHeight }
        : { w: source.naturalWidth, h: source.naturalHeight };

const reduceMotion = (): boolean =>
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

export function PipBubble({ round }: { readonly round: boolean }) {
    const navigate = useNavigate();
    const agent = useAgentActivity();
    const root = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const body = useRef<Body>({ x: 0, y: 0, vx: 0, vy: 0 });
    const placed = useRef(false);
    const flight = useRef<number | undefined>(undefined);
    const [hidden, setHidden] = useState(false);
    // Nothing is shown until the KVM has a picture to show: with none (no PiKVM set up yet) there is nothing to float.
    const [live, setLive] = useState(false);
    const [aspect, setAspect] = useState(16 / 9);
    const width = round ? BUBBLE : WINDOW_WIDTH;
    const height = round ? BUBBLE : Math.round(WINDOW_WIDTH / aspect);

    const area = useCallback((): Area => {
        const parent = root.current?.parentElement;
        return {
            width: parent?.clientWidth ?? 0,
            height: parent?.clientHeight ?? 0,
            w: width,
            h: height,
            inset: MARGIN,
        };
    }, [width, height]);

    const paint = useCallback((b: Body) => {
        body.current = b;
        const el = root.current;
        if (el)
            el.style.transform = `translate3d(${Math.round(b.x)}px, ${Math.round(b.y)}px, 0)`;
    }, []);

    const stopFlight = useCallback(() => {
        if (flight.current !== undefined) cancelAnimationFrame(flight.current);
        flight.current = undefined;
    }, []);

    // First place: the top right. Kept inside whenever the area or the window's own size changes.
    useLayoutEffect(() => {
        const a = area();
        if (a.width === 0) return;
        if (!placed.current) {
            placed.current = true;
            const first = keepInside(a.width, MARGIN, a);
            paint({ ...first, vx: 0, vy: 0 });
        } else {
            const kept = keepInside(body.current.x, body.current.y, a);
            paint({ ...body.current, ...kept });
        }
    }, [area, paint, hidden]);
    useEffect(() => {
        const parent = root.current?.parentElement;
        if (!parent || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            const kept = keepInside(body.current.x, body.current.y, area());
            paint({ ...body.current, ...kept });
        });
        observer.observe(parent);
        return () => observer.disconnect();
    }, [area, paint, hidden]);
    useEffect(() => stopFlight, [stopFlight]);

    // The copy of the picture. Drawn while this is shown, and not while the page is hidden.
    useEffect(() => {
        if (hidden) return;
        let frame = 0;
        let last = -Infinity;
        const draw = (now: number): void => {
            frame = requestAnimationFrame(draw);
            if (now - last < DRAW_EVERY_MS || document.hidden) return;
            last = now;
            const target = canvas.current;
            const source = pictureSource();
            const context = target?.getContext("2d");
            if (!target || !source || !context) return;
            const native = sizeOf(source);
            if (native.w === 0 || native.h === 0) return;
            if (!round)
                setAspect((was) =>
                    Math.abs(was - native.w / native.h) > 0.01
                        ? native.w / native.h
                        : was,
                );
            const scale = window.devicePixelRatio || 1;
            const pixels = {
                w: Math.round(width * scale),
                h: Math.round(height * scale),
            };
            if (target.width !== pixels.w || target.height !== pixels.h) {
                target.width = pixels.w;
                target.height = pixels.h;
            }
            // A bubble fills its circle and loses the edges of the picture; a window shows all of it.
            const fit = round
                ? Math.max(pixels.w / native.w, pixels.h / native.h)
                : pixels.w / native.w;
            const drawn = { w: native.w * fit, h: native.h * fit };
            context.drawImage(
                source,
                (pixels.w - drawn.w) / 2,
                (pixels.h - drawn.h) / 2,
                drawn.w,
                drawn.h,
            );
            setLive(true);
        };
        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    }, [hidden, round, width, height]);

    const fly = useCallback(
        (from: Body) => {
            stopFlight();
            const corner = cornerFor(from, area());
            if (reduceMotion()) {
                paint({ ...corner, vx: 0, vy: 0 });
                return;
            }
            let before = performance.now();
            const tick = (now: number): void => {
                const next = step(body.current, (now - before) / 1000, area(), corner);
                before = now;
                paint(next);
                flight.current =
                    next.vx === 0 && next.vy === 0
                        ? undefined
                        : requestAnimationFrame(tick);
            };
            paint(from);
            flight.current = requestAnimationFrame(tick);
        },
        [area, paint, stopFlight],
    );

    const drag = useRef<
        | {
              id: number;
              startX: number;
              startY: number;
              grabX: number;
              grabY: number;
              moved: boolean;
              samples: Sample[];
          }
        | undefined
    >(undefined);
    const dragged = useRef(false);

    const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
        if (event.button !== 0) return;
        stopFlight();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragged.current = false;
        drag.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            grabX: event.clientX - body.current.x,
            grabY: event.clientY - body.current.y,
            moved: false,
            samples: [
                { x: event.clientX, y: event.clientY, at: event.timeStamp },
            ],
        };
    };
    const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        if (
            !d.moved &&
            Math.hypot(event.clientX - d.startX, event.clientY - d.startY) <
                DRAG_SLOP
        )
            return;
        d.moved = true;
        dragged.current = true;
        d.samples.push({
            x: event.clientX,
            y: event.clientY,
            at: event.timeStamp,
        });
        if (d.samples.length > 12) d.samples.shift();
        const kept = keepInside(
            event.clientX - d.grabX,
            event.clientY - d.grabY,
            area(),
        );
        paint({ ...kept, vx: 0, vy: 0 });
    };
    const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        drag.current = undefined;
        if (!d.moved) return;
        const { vx, vy } = velocityOf(d.samples, event.timeStamp);
        fly({ ...body.current, vx, vy });
    };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (!event.shiftKey) return;
        const by: Record<string, [number, number] | undefined> = {
            ArrowLeft: [-NUDGE, 0],
            ArrowRight: [NUDGE, 0],
            ArrowUp: [0, -NUDGE],
            ArrowDown: [0, NUDGE],
        };
        const move = by[event.key];
        if (!move) return;
        event.preventDefault();
        stopFlight();
        paint({
            ...keepInside(
                body.current.x + move[0],
                body.current.y + move[1],
                area(),
            ),
            vx: 0,
            vy: 0,
        });
    };

    if (hidden) return null;
    const holds = agentHoldsInput(agent);
    return (
        <div
            ref={root}
            className="pip"
            data-shape={round ? "bubble" : "window"}
            data-agent={agent?.state}
            data-agent-lock={holds || undefined}
            data-live={live || undefined}
            role="group"
            aria-label="Live KVM screen"
            style={{ width, height }}
        >
            <button
                type="button"
                className="pip-open"
                aria-label={
                    holds
                        ? "Open the KVM screen. The agent is using it."
                        : "Open the KVM screen"
                }
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown}
                onClick={() => {
                    // A throw ends with a click on the same button: it must not also open the KVM.
                    if (dragged.current) {
                        dragged.current = false;
                        return;
                    }
                    void navigate({ to: "/kvm" });
                }}
            >
                <span className="pip-empty" aria-hidden="true">
                    <Monitor size={round ? 26 : 32} />
                </span>
                <canvas
                    ref={canvas}
                    className="pip-canvas"
                    width={width}
                    height={height}
                    aria-hidden="true"
                />
            </button>
            <button
                type="button"
                className="pip-close"
                aria-label="Hide the live screen"
                onClick={() => setHidden(true)}
            >
                <X size={12} weight="bold" />
            </button>
        </div>
    );
}
