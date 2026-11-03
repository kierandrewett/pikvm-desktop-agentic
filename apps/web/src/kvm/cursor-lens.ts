/**
 * The two things drawn over the picture that are not the picture: the cursor dot and the
 * trackpad magnifier. Every decision (when to show, where, how big, which part of the stream
 * is magnified) is the engine's view module; this only applies the answers to two elements.
 */

import {
    LENS_SIZE,
    beginLensTouch,
    createLensSize,
    lensActive,
    lensMag,
    lensPlace,
    lensSource,
    lensVisible,
    noteLensFingers,
    noteLensSpeed,
    paintMouseCursor,
    paintTrackpadCursor,
    quenchLens,
    type Clock,
    type LensSizeState,
    type PointerMachine,
} from "@pikvm/kvm-engine";

export interface PainterDeps {
    readonly pane: HTMLElement;
    readonly cursor: HTMLElement;
    /** Somebody else's pointer: drawn where the machine's cursor is while another client holds it and this one has no blob of its own to move. */
    readonly remote: HTMLElement;
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
    /** Another client moved the pointer and it is theirs (`show`), or this client moved it since (not `show`). */
    remote(show: boolean): void;
    /**
     * A finger moved `distance` px at the event's own time `at` (its speed decides whether the lens shows, after its
     * delay); no distance = a new touch began. Without `at` the moment of the call stands in.
     */
    lens(distance?: number, at?: number): void;
    /** The socket opened or closed: the blob must not claim a remote cursor that has stopped. */
    inputChanged(): void;
    dispose(): void;
}

export function createPainter(deps: PainterDeps): Painter {
    const { pane, cursor, remote, lens, clock, machine } = deps;
    let lensState: LensSizeState = createLensSize();
    let lensBelow = false;
    let lensFrame = 0;
    // The moves' own timestamps (the page's event clock) and `clock` count from different origins. The lens's waits
    // run on the moves' axis; this is how far `clock` is ahead of it: the smallest lag seen in this gesture, so a batch
    // of moves handled together does not look later than it is.
    let lag = Infinity;
    const lensNow = (): number => (lag === Infinity ? clock.now() : clock.now() - lag);
    // One size, set once: the canvas's pixels follow the screen's density.
    lens.style.width = `${LENS_SIZE}px`;
    lens.style.height = `${LENS_SIZE}px`;

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

    const hideRemote = (): void => {
        remote.style.display = "none";
    };

    const hideLens = (): void => {
        lens.classList.remove("on");
    };

    const relative = (): boolean => machine.environment.mouseMode === "relative";

    /**
     * Runs every frame while the lens is up or a change to it is waiting: the delays need a clock, and a finger that
     * has stopped (or lifted) sends no move to run them. Redraws the lens while it is up, so the target's own changes
     * appear in it and a lifted finger's lens stays where the cursor is until it goes.
     */
    const draw = (): void => {
        lensFrame = 0;
        lensState = noteLensFingers(lensState, machine.pointersDown === 1, lensNow());
        const at = machine.virtualCursorClient;
        const env = machine.environment;
        const scale = machine.currentView.scale;
        const box = machine.pictureBox;
        const allowed = lensVisible({
            trackpadActive: machine.trackpadActive,
            relative: relative(),
            hidOpen: deps.hidOpen(),
            modalOpen: deps.modalOpen(),
            at,
            scale,
            box,
            nat: env.nat,
        });
        if (!allowed || !at || !box) {
            // A hard limit: gone now, with no delay, and nothing left waiting.
            lensState = quenchLens(lensState);
            hideLens();
            return;
        }
        if (!lensState.shown) {
            hideLens();
            if (lensActive(lensState)) lensFrame = deps.frame(draw);
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const px = Math.round(LENS_SIZE * dpr);
        if (lens.width !== px) {
            lens.width = px;
            lens.height = px;
        }
        const ctx = lens.getContext("2d");
        if (!ctx) return;
        const src = lensSource(LENS_SIZE, px, lensMag(scale), box, env.nat, at);
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
        const spot = lensPlace(at, pane.getBoundingClientRect(), lensBelow);
        lensBelow = spot.below;
        place(lens, spot.x, spot.y);
        lens.classList.add("on");
        lensFrame = deps.frame(draw);
    };

    /** Drawn now, not on the next frame: the cursor has just moved and the lens must not trail it. */
    const drawNow = (): void => {
        if (lensFrame) deps.cancelFrame(lensFrame);
        draw();
    };

    const painter: Painter = {
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
        remote(show) {
            if (!show) {
                hideRemote();
                return;
            }
            const at = machine.virtualCursorClient;
            // On the trackpad the blob is the cursor and has just moved with it; nothing else is drawn.
            if (machine.trackpadActive) {
                painter.trackpad();
                const blob = paintTrackpadCursor({
                    trackpadActive: true,
                    relative: relative(),
                    hidOpen: deps.hidOpen(),
                    modalOpen: deps.modalOpen(),
                    at,
                });
                if (blob?.show) {
                    hideRemote();
                    return;
                }
            }
            // Anywhere else (the desktop's own pointer is the OS's and is not the target's now, direct touch has none)
            // the other client's pointer is drawn as theirs.
            if (!at || deps.modalOpen()) hideRemote();
            else {
                place(remote, at.x, at.y);
                remote.style.display = "block";
            }
        },
        lens(distance, at) {
            if (distance === undefined) {
                // A new touch: a lens still up stays and its hide is cancelled; with none up it starts from nothing,
                // and a change that was waiting is dropped.
                lensState = beginLensTouch(lensState, lensNow());
                lag = Infinity;
                if (!lensState.shown) {
                    lensBelow = false;
                    hideLens();
                }
                drawNow();
                return;
            }
            if (at !== undefined) lag = Math.min(lag, clock.now() - at);
            lensState = noteLensSpeed(lensState, distance, at ?? lensNow());
            drawNow();
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
    return painter;
}
