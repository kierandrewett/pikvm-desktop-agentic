/**
 * The two things drawn over the picture that are not the picture: the cursor dot and the
 * trackpad magnifier. Every decision (when to show, where, how big, which part of the stream
 * is magnified) is the engine's view module; this only applies the answers to two elements.
 */

import {
    LENS_LINGER_MS,
    createLensSize,
    lensReachable,
    lensSource,
    lensVisible,
    noteLensSpeed,
    paintMouseCursor,
    paintTrackpadCursor,
    updateLensSize,
    type Clock,
    type LensSizeState,
    type PointerMachine,
} from "@pikvm/kvm-engine";

export interface PainterDeps {
    readonly pane: HTMLElement;
    readonly cursor: HTMLElement;
    readonly lens: HTMLCanvasElement;
    readonly clock: Clock;
    readonly machine: PointerMachine;
    /** Whichever of the <img> and <video> is showing: the lens magnifies what is under it. */
    readonly source: () => HTMLImageElement | HTMLVideoElement;
    readonly hidOpen: () => boolean;
    readonly modalOpen: () => boolean;
    readonly backgrounded: () => boolean;
    readonly frame: (callback: () => void) => number;
    readonly cancelFrame: (id: number) => void;
}

export interface Painter {
    /** A mouse pointer is over (or dragging across) the picture. */
    mouse(x: number, y: number, dragging: boolean): void;
    hideMouse(): void;
    /** The trackpad's virtual cursor moved or appeared. */
    trackpad(): void;
    /**
     * A finger moved `distance` px at the event's own time `at` (feeds the lens's speed, so its zoom); no
     * distance = a new touch began. Without `at` the moment of the call stands in.
     */
    lens(distance?: number, at?: number): void;
    /** The socket opened or closed: the blob must not claim a remote cursor that has stopped. */
    inputChanged(): void;
    dispose(): void;
}

export function createPainter(deps: PainterDeps): Painter {
    const { pane, cursor, lens, clock, machine } = deps;
    let lensSize: LensSizeState = createLensSize();
    let lensUntil = 0;
    let lensFrame = 0;

    const place = (el: HTMLElement, x: number, y: number): void => {
        const rect = pane.getBoundingClientRect();
        el.style.left = `${x - rect.left}px`;
        el.style.top = `${y - rect.top}px`;
    };

    const showCursor = (x: number, y: number): void => {
        place(cursor, x, y);
        cursor.style.display = "block";
    };
    const hideCursor = (): void => {
        cursor.style.display = "none";
    };

    const hideLens = (): void => {
        lens.classList.remove("on");
        delete lens.dataset.mag;
    };

    const relative = (): boolean => machine.environment.mouseMode === "relative";

    const draw = (): void => {
        lensFrame = 0;
        const now = clock.now();
        // Held still, still looking.
        if (machine.trackpadActive && machine.pointersDown > 0) lensUntil = now + LENS_LINGER_MS;
        const at = machine.virtualCursorClient;
        const env = machine.environment;
        const scale = machine.currentView.scale;
        const box = machine.pictureBox;
        // The finger's speed sets the zoom; the clock runs even while the lens is hidden.
        const stepped = updateLensSize(lensSize, now, scale);
        lensSize = stepped.state;
        const allowed = lensVisible({
            trackpadActive: machine.trackpadActive,
            relative: relative(),
            hidOpen: deps.hidOpen(),
            modalOpen: deps.modalOpen(),
            at,
            scale,
            now,
            until: lensUntil,
            box,
            nat: env.nat,
        });
        if (!allowed || !at || !box) {
            hideLens();
            return;
        }
        if (!stepped.visible) {
            // Not earned yet (resting, or travelling too fast to want a lens): stay out of the way, keep watching.
            hideLens();
            lensFrame = deps.frame(draw);
            return;
        }
        const size = stepped.size;
        const dpr = window.devicePixelRatio || 1;
        const px = Math.round(size * dpr);
        if (lens.width !== px) {
            lens.width = px;
            lens.height = px;
            lens.style.width = `${size}px`;
            lens.style.height = `${size}px`;
        }
        const ctx = lens.getContext("2d");
        if (!ctx) return;
        const src = lensSource(size, px, stepped.mag, box, env.nat, at);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, px, px);
        if (src.visible) {
            try {
                ctx.imageSmoothingEnabled = src.smoothing;
                ctx.drawImage(deps.source(), src.sx, src.sy, src.sw, src.sh, src.dx, src.dy, src.dw, src.dh);
            } catch {
                hideLens();
                return;
            }
        }
        // The cursor's hotspot, at the centre.
        ctx.beginPath();
        ctx.arc(px / 2, px / 2, 4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(91, 140, 255, 0.55)";
        ctx.fill();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.stroke();
        place(lens, at.x, at.y);
        lens.dataset.mag = stepped.mag.toFixed(2);
        lens.classList.add("on");
        // Redrawn every frame while it shows, so the target's own changes appear in it.
        lensFrame = deps.frame(draw);
    };

    return {
        mouse(x, y, dragging) {
            const paint = paintMouseCursor({
                modalOpen: deps.modalOpen(),
                backgrounded: deps.backgrounded(),
                hidOpen: deps.hidOpen(),
                box: machine.pictureBox,
                x,
                y,
                dragging,
            });
            pane.style.cursor = paint.style;
            if (paint.show) showCursor(paint.x, paint.y);
            else hideCursor();
        },
        hideMouse: hideCursor,
        trackpad() {
            const paint = paintTrackpadCursor({
                trackpadActive: machine.trackpadActive,
                relative: relative(),
                hidOpen: deps.hidOpen(),
                modalOpen: deps.modalOpen(),
                at: machine.virtualCursorClient,
            });
            if (!paint) return;
            if (paint.show) showCursor(paint.x, paint.y);
            else hideCursor();
        },
        lens(distance, at) {
            if (distance === undefined) {
                // A new touch starts from nothing: no lens until the finger has moved.
                lensSize = createLensSize();
                hideLens();
            } else lensSize = noteLensSpeed(lensSize, distance, at ?? clock.now());
            // The lens magnifies less the further the picture is pinched in, and goes away once it adds nothing.
            if (!lensReachable(machine.currentView.scale)) return;
            lensUntil = clock.now() + LENS_LINGER_MS;
            if (!lensFrame) lensFrame = deps.frame(draw);
        },
        inputChanged() {
            if (deps.hidOpen()) {
                if (pane.style.cursor === "not-allowed") pane.style.cursor = "";
                return;
            }
            hideCursor();
            pane.style.cursor = "not-allowed";
        },
        dispose() {
            deps.cancelFrame(lensFrame);
            lensFrame = 0;
        },
    };
}
