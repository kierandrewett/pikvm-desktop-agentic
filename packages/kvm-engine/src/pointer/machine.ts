// The touch / pointer gesture machine.
//
// Input is DOM-shaped pointer events (already reduced to data), output is HID
// commands plus a few UI commands, all data. Nothing here reads a clock, a timer or
// the DOM: time arrives stamped on the inputs and timers are REQUESTED as commands,
// so a test can drive any gesture, to the millisecond, with a manual clock.
//
// Two ways of using a touch screen, after RustDesk's mobile client:
//   TRACKPAD (default): a drag moves the cursor by a delta; tap = left click, hold
//     then lift = right click, hold then move = drag, two-finger tap = right click,
//     two-finger drag = scroll, pinch = zoom. On an absolute Pi the zoomed view
//     follows the cursor, so there is nothing to pan.
//   DIRECT: the touch point IS the pointer. One finger pans a zoomed view.
// Mouse and pen are ABSOLUTE: the cursor goes exactly where you point.
//
// The Pi's mouse output follows the input in use: absolute for a mouse, a pen and
// direct touch; relative for the trackpad, unless the user pinned the trackpad to
// absolute or the Pi has no relative output.

import type { Box, Point } from "../view/geometry";
import { clampNorm, fracInBox, fracToNorm, normToClient } from "../view/geometry";
import { LENS_ENGAGE_PX } from "../view/lens";
import { IDENTITY_VIEW, clampPan, followCursor, panBy, viewEquals, viewPictureBox, zoomAround } from "../view/transform";
import type { ViewTransform } from "../view/transform";
import {
    ABS_STEP_SPACING_MS,
    ABS_SWEEP_MS,
    ABS_WAIT_MS,
    DEFAULT_ENV,
    HOLD_MS,
    MOVE_SLOP,
    NUDGE_MAX,
    PINCH_RATIO,
    PINCH_STEP_EPSILON,
    REL_CHUNK,
    REL_OWE_MAX,
    REL_SENS,
    REMOTE_HOLD_MS,
    TOUCH_SLOP,
    TRACKPAD_SENS,
    TWO_FINGER_DRAG_PX,
    TWO_FINGER_TAP_MS,
    WHEEL_STEP_PX,
    WHEEL_ZOOM_STEP,
} from "./types";
import type {
    HidButton,
    PointerCommand,
    PointerDownInput,
    PointerEnv,
    PointerInput,
    PointerMoveInput,
    PointerOutput,
    PointerPhase,
    PointerUpInput,
    PointerRemoteInput,
    PointerWheelInput,
} from "./types";

/** The three buttons the target's HID can carry, or null. Thumb buttons (3, 4) are the browser's back and forward. */
export function hidButtonFor(button: number): HidButton | null {
    if (button === 0) return "left";
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return null;
}

/** What a queued direct-touch step does once it has pointed: press and hold left, or tap. */
type StepAction = { readonly kind: "press" } | { readonly kind: "click"; readonly button: HidButton };

interface Step {
    readonly x: number;
    readonly y: number;
    readonly then: StepAction;
    readonly at: number;
}

interface StartPoint {
    readonly x: number;
    readonly y: number;
    readonly id: number;
}

interface TwoFingerStart {
    readonly t: number;
    moved: boolean;
    readonly cx: number;
    readonly cy: number;
    readonly d0: number;
    kind: "pinch" | "drag" | null;
}

export interface PointerMachineOptions {
    /** A phone starts as touch, so the Pi's mouse output is right before the first gesture. */
    readonly coarsePointer?: boolean;
}

const HOLD_TIMER = "hold";
const SWEEP_PREFIX = "absSweep:";
const STEP_PREFIX = "absStep:";
const REMOTE_TIMER = "remote";

export class PointerMachine {
    private env: PointerEnv;
    private view: ViewTransform;
    private out: PointerCommand[] = [];
    private now = 0;

    private readonly pts = new Map<number, Point>();
    private startPt: StartPoint | null = null;
    private moved = false;
    private pinchDist = 0;
    private pinchCx = 0;
    private pinchCy = 0;
    private pressing = false; // left button held by drag-lock or hold-to-drag
    private isMouseDown = false; // a mouse pointer is down (even one whose button the HID cannot carry)
    private holdTimerOn = false;
    private holdArmed = false;
    private holdAt: Point = { x: 0, y: 0 };
    private twoStart: TwoFingerStart | null = null;
    private scrollAcc = 0;
    private gestureDirect = false; // this one-finger gesture points directly (direct mode, or a pen)
    private lastInputTouch: boolean;
    private readonly heldButtons = new Set<HidButton>();
    private clickMods: string[] = [];

    // Virtual cursor in kvmd units. Trackpad drags accumulate into it and absolute
    // moves are sent, so trackpad mode works with the default (absolute) Pi mouse.
    private readonly vcur = { x: 0, y: 0 };
    private lastMoveX = 0;
    private lastMoveY = 0;
    // Travel owed to a RELATIVE-mode Pi, in target pixels, as fractions so slow drags still add up.
    private relOweX = 0;
    private relOweY = 0;
    private moveDirty = false;
    private frameQueued = false;
    // Another client's position that arrived while this one was moving the pointer, and when this one last did.
    private remoteWaiting: Point | null = null;
    private remoteShown = false;
    private remoteTimerOn = false;
    private localAt = Number.NEGATIVE_INFINITY;

    private absPending: Step[] = [];
    private readonly scheduled = new Map<string, Step>();
    private seq = 0;

    constructor(env: PointerEnv = DEFAULT_ENV, view: ViewTransform = IDENTITY_VIEW, opts: PointerMachineOptions = {}) {
        this.env = env;
        this.view = view;
        this.lastInputTouch = opts.coarsePointer ?? false;
    }

    /* ---- read-only state, for the shell and tests ---- */

    get currentView(): ViewTransform {
        return this.view;
    }

    /** The trackpad's virtual cursor in kvmd units. */
    get virtualCursor(): Readonly<Point> {
        return { x: this.vcur.x, y: this.vcur.y };
    }

    get environment(): PointerEnv {
        return this.env;
    }

    /** The picture's box in client pixels under the current view. */
    get pictureBox(): Box | null {
        return this.box();
    }

    /** The virtual cursor in client pixels, or null with no picture. */
    get virtualCursorClient(): Point | null {
        return normToClient(this.box(), this.vcur.x, this.vcur.y);
    }

    get trackpadActive(): boolean {
        return this.lastInputTouch && this.env.touchMode === "trackpad";
    }

    /** The input in use is touch (not a mouse or pen). */
    get touchInUse(): boolean {
        return this.lastInputTouch;
    }

    /** Pointers currently down: the lens shows only while exactly one is. */
    get pointersDown(): number {
        return this.pts.size;
    }

    get phase(): PointerPhase {
        if (this.pts.size === 0) return this.pressing ? "dragging" : "idle";
        if (this.heldButtons.size > 0 || this.isMouseDown) return "mouse";
        if (this.pts.size >= 2) return this.twoStart?.kind === "pinch" ? "pinching" : "two-finger";
        if (!this.startPt) return "spent";
        if (this.pressing || this.moved) return "dragging";
        return this.holdArmed ? "armed" : "pending";
    }

    /** Left button owed to the target right now (drag-lock, hold-to-drag). */
    get leftHeld(): boolean {
        return this.pressing;
    }

    /** The mouse buttons currently down on the target. */
    get heldMouseButtons(): readonly HidButton[] {
        return [...this.heldButtons];
    }

    /** Direct-touch steps waiting for the Pi to go absolute. */
    get pendingAbsolute(): number {
        return this.absPending.length;
    }

    /** Relative travel owed to the Pi, in target pixels. */
    get relativeOwed(): Readonly<Point> {
        return { x: this.relOweX, y: this.relOweY };
    }

    /* ---- the one entry point ---- */

    handle(input: PointerInput): PointerOutput {
        this.out = [];
        this.now = input.t;
        let prevent = false;
        // Anything a pointer does on this client is a write to the target's pointer, whether or not the HID gets it.
        if (input.type === "down" || input.type === "move" || input.type === "up" || input.type === "wheel") this.noteLocalWrite();
        switch (input.type) {
            case "down":
                prevent = this.onDown(input);
                break;
            case "move":
                prevent = this.onMove(input);
                break;
            case "up":
                this.onUp(input);
                break;
            case "wheel":
                prevent = this.onWheel(input);
                break;
            case "enter":
                if (!this.env.modalOpen && input.kind === "mouse") {
                    // A mouse entering the live surface is a mouse in use: the Pi goes ABSOLUTE.
                    this.lastInputTouch = false;
                    this.emit({ type: "setMouseOutput", absolute: true });
                }
                break;
            case "leave":
                // Not while a button is held: the drag is still running and the blob is
                // pinned to the edge, which is the only feedback that it still is.
                if (input.buttons === 0 && input.kind === "mouse") this.emit({ type: "mouseCursorHide" });
                break;
            case "blur":
                this.onBlur();
                break;
            case "timer":
                this.onTimer(input.id);
                break;
            case "frame":
                this.frameQueued = false;
                this.flushMove();
                break;
            case "mouseMode":
                this.onMouseMode(input.mode);
                break;
            case "env":
                this.onEnv(input.env);
                break;
            case "view":
                this.view = input.view;
                this.redrawRemote();
                break;
            case "remote":
                this.onRemote(input);
                break;
        }
        const commands = this.out;
        this.out = [];
        return { commands, preventDefault: prevent };
    }

    /* ---- plumbing ---- */

    private emit(c: PointerCommand): void {
        this.out.push(c);
    }

    private box(): Box | null {
        return viewPictureBox(this.env.pane, this.view, this.env.nat);
    }

    private fracAt(x: number, y: number, clamp = false): { fx: number; fy: number } | null {
        return fracInBox(this.box(), x, y, clamp);
    }

    private setView(next: ViewTransform): void {
        if (viewEquals(next, this.view)) return;
        this.view = next;
        this.emit({ type: "view", view: next });
        this.redrawRemote();
    }

    private isRelative(): boolean {
        return this.env.mouseMode === "relative";
    }

    private isAbsolute(): boolean {
        return this.env.mouseMode === "absolute";
    }

    /** True = the Pi output this input wants is absolute. */
    private wantAbsOutput(): boolean {
        return !this.trackpadActive || this.env.touchHid === "abs";
    }

    /**
     * The trackpad wants relative and the Pi offers it, but has not reported the
     * switch yet. Moves are HELD as relative debt until it does: sent as absolute
     * meanwhile, the first drag would jump the target's cursor to wherever the
     * client's estimate happened to be.
     */
    private awaitingRelative(): boolean {
        return this.trackpadActive && !this.wantAbsOutput() && !this.isRelative() && this.env.relativeAvailable;
    }

    private followingCursor(): boolean {
        return this.trackpadActive && this.view.scale > 1 && !this.isRelative();
    }

    private followCursorNow(): void {
        if (!this.followingCursor()) return;
        this.setView(followCursor(this.view, this.vcur.x, this.vcur.y, this.env.pane, this.env.nat));
    }

    private onEnv(patch: Partial<PointerEnv>): void {
        const before = this.env;
        this.env = { ...before, ...patch };
        const resized =
            this.env.pane.width !== before.pane.width ||
            this.env.pane.height !== before.pane.height ||
            this.env.nat.w !== before.nat.w ||
            this.env.nat.h !== before.nat.h;
        if (!resized) return;
        // The pan bound is a function of the pane's size: anything that resizes the pane
        // can strand the picture outside it, so re-clamp against the box that exists now.
        this.setView(clampPan(this.view, this.env.pane, this.env.nat));
        if (this.trackpadActive) this.emit({ type: "trackpadCursor" });
        this.redrawRemote();
    }

    /* ---- moving the target's cursor ---- */

    private queueMove(): void {
        this.moveDirty = true;
        if (this.frameQueued) return;
        this.frameQueued = true;
        this.emit({ type: "requestFrame" });
    }

    /** Set the virtual cursor to a client point, absolutely. Null when it is off the picture. */
    private moveTo(x: number, y: number, force: boolean, clamp = false): void {
        const f = this.fracAt(x, y, clamp);
        if (!f) return;
        this.vcur.x = fracToNorm(f.fx);
        this.vcur.y = fracToNorm(f.fy);
        this.moveDirty = true;
        if (force) this.flushMove();
        else this.queueMove();
    }

    private flushMove(): void {
        if (!this.moveDirty) return;
        this.moveDirty = false;
        if (!this.env.windowFocused) return; // background window: do not move the KVM cursor
        if (this.awaitingRelative()) {
            this.emit({ type: "setMouseOutput", absolute: false }); // throttled by the executor; re-asks if lost
            return;
        }
        // By the mode the Pi CONFIRMED, not the one asked for: a relative Pi drops
        // absolute moves, so until it reports the switch it still gets deltas.
        if (this.isRelative()) {
            let sx = Math.trunc(this.relOweX);
            let sy = Math.trunc(this.relOweY);
            this.relOweX -= sx;
            this.relOweY -= sy;
            // kvmd takes at most 127 per report; a fast flick is several.
            while (sx || sy) {
                const cx = Math.max(-REL_CHUNK, Math.min(REL_CHUNK, sx));
                const cy = Math.max(-REL_CHUNK, Math.min(REL_CHUNK, sy));
                this.emit({ type: "relative", dx: cx, dy: cy });
                sx -= cx;
                sy -= cy;
            }
            return;
        }
        this.relOweX = 0;
        this.relOweY = 0;
        this.emit({ type: "move", x: Math.round(this.vcur.x), y: Math.round(this.vcur.y) });
    }

    /** One trackpad drag step, in finger pixels. */
    private relMove(dx: number, dy: number): void {
        // Measured against the same picture box the absolute path maps through, not the
        // element's layout box: the trackpad must not get COARSER exactly when you have
        // zoomed in to be precise, and the letterbox bars stay out of the gain.
        const box = this.box();
        const w = (box && box.w) || this.env.pane.width || 1;
        const h = (box && box.h) || this.env.pane.height || 1;
        this.vcur.x = clampNorm(this.vcur.x + (dx / w) * TRACKPAD_SENS * 65534);
        this.vcur.y = clampNorm(this.vcur.y + (dy / h) * TRACKPAD_SENS * 65534);
        if (this.isRelative() || this.awaitingRelative()) {
            // Bounded, so a switch that never comes cannot bank a screen-crossing jump.
            this.relOweX = Math.max(-REL_OWE_MAX, Math.min(REL_OWE_MAX, this.relOweX + dx * REL_SENS));
            this.relOweY = Math.max(-REL_OWE_MAX, Math.min(REL_OWE_MAX, this.relOweY + dy * REL_SENS));
            // Sent on every move, not once a frame: each touch move is a small step, and
            // kvmd squashes a burst itself. Batching per frame turned a steady drag into hops.
            this.moveDirty = true;
            this.flushMove();
            return;
        }
        this.queueMove();
        this.followCursorNow();
        this.emit({ type: "trackpadCursor" });
    }

    /* ---- clicks and the absolute wait ---- */

    private tapClick(button: HidButton): void {
        this.flushMove(); // make sure the cursor is at its latest position first
        this.emit({ type: "click", button });
    }

    private runStep(step: Step): void {
        this.moveTo(step.x, step.y, true);
        if (step.then.kind === "click") this.tapClick(step.then.button);
        else if (this.pressing) this.emit({ type: "button", button: "left", down: true }); // else the finger lifted before the Pi switched
    }

    /**
     * Run a "point here, then press" step only once the Pi is ABSOLUTE.
     *
     * Direct touch can begin while the Pi is still relative from the trackpad, and a
     * relative Pi ignores absolute moves: the press would land wherever the cursor
     * already was. So the step waits for the hid event that confirms absolute mode,
     * and is dropped (with a word about it) if that does not come quickly. An
     * unknown mode is waited on as well: before the first hid report there is no
     * telling where a press would land. Steps queue in order, so a double tap made
     * during the switch still reaches the target as two clicks.
     */
    private pointAt(x: number, y: number, then: StepAction): void {
        // Off the picture (the letterbox, or the dark margin of a zoomed view) there is
        // nothing to point at, so nothing is sent.
        if (!this.fracAt(x, y)) return;
        const step: Step = { x, y, then, at: this.now };
        if (this.isAbsolute() && this.absPending.length === 0) {
            this.runStep(step);
            return;
        }
        this.emit({ type: "setMouseOutput", absolute: true });
        this.absPending.push(step);
        this.emit({ type: "startTimer", id: `${SWEEP_PREFIX}${++this.seq}`, ms: ABS_SWEEP_MS });
    }

    private fresh(step: Step): boolean {
        return this.now - step.at < ABS_WAIT_MS;
    }

    private sweepStale(): void {
        const before = this.absPending.length;
        this.absPending = this.absPending.filter((s) => this.fresh(s));
        if (this.absPending.length === before) return;
        this.emit({
            type: "notice",
            error: true,
            message: this.isRelative()
                ? "The Pi did not switch to absolute mouse, so that tap was not sent"
                : "The Pi has not reported its mouse mode yet, so that tap was not sent",
        });
    }

    private onMouseMode(mode: PointerEnv["mouseMode"]): void {
        this.env = { ...this.env, mouseMode: mode };
        if (mode === "absolute" && this.absPending.length) {
            const steps = this.absPending.filter((s) => this.fresh(s));
            this.absPending = [];
            // Spaced past a click's 45ms hold, so one click is up before the next goes down.
            steps.forEach((s, i) => {
                if (i === 0) {
                    this.runStep(s);
                    return;
                }
                const id = `${STEP_PREFIX}${++this.seq}`;
                this.scheduled.set(id, s);
                this.emit({ type: "startTimer", id, ms: i * ABS_STEP_SPACING_MS });
            });
        }
        // Travel held while the Pi switched to relative goes out now.
        if (mode === "relative" && (this.relOweX || this.relOweY)) this.queueMove();
    }

    private onTimer(id: string): void {
        if (id === HOLD_TIMER) {
            this.holdTimerOn = false;
            if (this.moved || !this.startPt) return;
            this.holdArmed = true;
            this.emit({ type: "holdCue", on: true, x: this.holdAt.x, y: this.holdAt.y, direct: this.gestureDirect });
        } else if (id.startsWith(SWEEP_PREFIX)) {
            this.sweepStale();
        } else if (id.startsWith(STEP_PREFIX)) {
            const step = this.scheduled.get(id);
            this.scheduled.delete(id);
            if (step) this.runStep(step);
        } else if (id === REMOTE_TIMER) {
            this.onRemoteHold();
        }
    }

    /* ---- another client moved the pointer ---- */

    /** This client is moving the pointer, or just was: what another client does meanwhile waits. */
    private localActive(): boolean {
        return (
            this.pts.size > 0 ||
            this.pressing ||
            this.isMouseDown ||
            this.heldButtons.size > 0 ||
            this.now - this.localAt < REMOTE_HOLD_MS
        );
    }

    /**
     * The shared cursor moved. Last writer wins: a position from another client is taken at once while this one is
     * idle, and held back while it is moving the pointer itself (with a short hold after, so a finger that lifts does
     * not see the cursor leap away under it). Held back is not dropped: the newest waits, and is taken when this
     * client has been still, unless this client's own newer move has come back from the host first.
     */
    private onRemote(i: PointerRemoteInput): void {
        if (i.own) {
            this.remoteWaiting = null;
            return;
        }
        if (this.localActive()) {
            this.remoteWaiting = { x: i.x, y: i.y };
            // One wake-up, not one per update: a remote that keeps moving must not push the hand-over away.
            if (!this.remoteTimerOn) {
                this.remoteTimerOn = true;
                this.emit({ type: "startTimer", id: REMOTE_TIMER, ms: REMOTE_HOLD_MS });
            }
            return;
        }
        this.takeRemote(i.x, i.y);
    }

    private onRemoteHold(): void {
        this.remoteTimerOn = false;
        const waiting = this.remoteWaiting;
        if (!waiting) return;
        if (this.localActive()) {
            // Still at it (a finger is down, or it moved a moment ago): look again after another hold.
            this.remoteTimerOn = true;
            this.emit({ type: "startTimer", id: REMOTE_TIMER, ms: REMOTE_HOLD_MS });
            return;
        }
        this.takeRemote(waiting.x, waiting.y);
    }

    private takeRemote(x: number, y: number): void {
        this.remoteWaiting = null;
        this.vcur.x = clampNorm(x);
        this.vcur.y = clampNorm(y);
        this.remoteShown = true;
        this.emit({ type: "remoteCursor", show: true });
    }

    /** This client moved the pointer: it is no longer somebody else's. */
    private noteLocalWrite(): void {
        this.localAt = this.now;
        if (!this.remoteShown) return;
        this.remoteShown = false;
        this.emit({ type: "remoteCursor", show: false });
    }

    /** The picture moved or changed size under a pointer that is drawn: draw it again where it now belongs. */
    private redrawRemote(): void {
        if (this.remoteShown) this.emit({ type: "remoteCursor", show: true });
    }

    /* ---- click modifiers (mouse) ---- */

    private pressClickMods(mods: readonly string[]): void {
        this.releaseClickMods();
        for (const m of mods) this.emit({ type: "key", key: m, down: true });
        this.clickMods = [...mods];
    }

    private releaseClickMods(): void {
        for (let i = this.clickMods.length - 1; i >= 0; i--) {
            this.emit({ type: "key", key: this.clickMods[i] as string, down: false });
        }
        this.clickMods = [];
    }

    /**
     * Let go of everything the target is still holding. A release we never saw is
     * the worst kind of stuck: the button stays down on the TARGET, so the remote
     * window keeps following the cursor with nothing held on this side.
     */
    private releaseHeldMouseButtons(): void {
        if (this.heldButtons.size === 0) return;
        for (const b of this.heldButtons) this.emit({ type: "button", button: b, down: false });
        this.heldButtons.clear();
        this.isMouseDown = false;
        this.releaseClickMods();
    }

    private releasePressing(): void {
        if (!this.pressing) return;
        this.pressing = false;
        this.emit({ type: "button", button: "left", down: false });
    }

    private onBlur(): void {
        this.releaseHeldMouseButtons();
        this.releaseClickMods();
        // A touch hold-to-drag or drag-lock press is just as stuck if the window goes away mid-gesture.
        this.releasePressing();
        this.cancelHold();
        this.holdArmed = false;
        this.pts.clear();
        this.startPt = null;
        this.twoStart = null;
        this.moved = false;
        this.isMouseDown = false;
    }

    /* ---- hold ---- */

    private cancelHold(): void {
        if (!this.holdTimerOn) return;
        this.holdTimerOn = false;
        this.emit({ type: "cancelTimer", id: HOLD_TIMER });
    }

    private disarmHold(): boolean {
        const was = this.holdArmed;
        this.holdArmed = false;
        if (was) this.emit({ type: "holdCue", on: false, direct: this.gestureDirect });
        return was;
    }

    /** Armed and moved: press left at the finger and let the move drag. */
    private startHoldDrag(): void {
        this.disarmHold();
        this.pressing = true;
        if (this.gestureDirect && this.startPt) {
            this.pointAt(this.startPt.x, this.startPt.y, { kind: "press" });
        } else {
            this.flushMove();
            this.emit({ type: "button", button: "left", down: true });
        }
    }

    /* ---- pointer down ---- */

    private onDown(i: PointerDownInput): boolean {
        if (this.env.modalOpen) return false;
        this.lastInputTouch = i.kind === "touch";
        this.emit({ type: "setMouseOutput", absolute: this.wantAbsOutput() });

        if (i.kind === "mouse") return this.onMouseDown(i);

        this.emit({ type: "capture", id: i.id, on: true });
        this.pts.set(i.id, { x: i.x, y: i.y });
        // Keep focus where it is: a touch that moves focus off the hidden field closes
        // the soft keyboard. preventDefault stops the focus change and the compatibility
        // mouse events, nothing else.
        const prevent = true;

        if (this.pts.size === 2) {
            this.cancelHold();
            this.disarmHold();
            this.pinchDist = this.twoDist();
            const c = this.centroid();
            this.pinchCx = c.x;
            this.pinchCy = c.y;
            this.scrollAcc = 0;
            // Where the gesture began, kept apart from pinchCx/pinchCy: those are rewritten at
            // the end of every move because scroll and pan work off the delta since the last
            // one, so "has this moved?" measured against them asked whether the LAST event
            // jumped 8px, not whether the gesture had travelled.
            this.twoStart = { t: i.t, moved: false, cx: c.x, cy: c.y, d0: this.pinchDist, kind: null };
            // A second finger means this is not a tap any more; without this the first
            // finger released as a left click on top of whatever the two-finger gesture did.
            this.moved = true;
            return prevent;
        }
        // A third finger is not a gesture: it must not restart the first-touch state and
        // turn lifting it into a tap.
        if (this.pts.size > 2) return prevent;

        // First touch. A pen points directly, like the desktop mouse it stands in for.
        this.gestureDirect = i.kind !== "touch" || this.env.touchMode === "direct";
        if (!this.gestureDirect) {
            // A finger on the trackpad brings the cursor and its lens up, so you can
            // see what a tap or a hold will hit before it does.
            this.emit({ type: "trackpadCursor" });
            this.emit({ type: "lens" });
        }
        this.startPt = { x: i.x, y: i.y, id: i.id };
        this.moved = false;
        this.holdArmed = false;
        if (this.env.dragLock) {
            // Drag-lock: hold left so the next move drags. Direct touch presses where the finger is.
            this.pressing = true;
            if (this.gestureDirect) this.pointAt(i.x, i.y, { kind: "press" });
            else this.emit({ type: "button", button: "left", down: true });
        } else {
            // Hold still to arm. Once armed, moving drags and lifting without moving is a
            // right click. A drag used to start from any touch landing within 300ms of the
            // last tap, so two quick swipes highlighted text by accident.
            this.holdAt = { x: i.x, y: i.y };
            this.holdTimerOn = true;
            this.emit({ type: "startTimer", id: HOLD_TIMER, ms: HOLD_MS });
        }
        return prevent;
    }

    private onMouseDown(i: PointerDownInput): boolean {
        // Only act on clicks INSIDE the actual picture; the letterbox is not a KVM click.
        if (!this.fracAt(i.x, i.y)) return false;
        this.emit({ type: "capture", id: i.id, on: true });
        this.pts.set(i.id, { x: i.x, y: i.y });
        this.isMouseDown = true;
        // Desktop: the global key handler already owns the keyboard, so just drop focus
        // from whatever had it. Web: hand focus to the hidden input, and keep it there by
        // stopping the default (the click would otherwise focus the body and every key
        // typed next would go nowhere).
        this.emit({ type: "focus", target: this.env.desktop ? "none" : "keyboard" });
        const prevent = !this.env.desktop;
        const b = hidButtonFor(i.button);
        if (!b) return prevent; // a thumb button the target's HID cannot carry
        this.moveTo(i.x, i.y, true);
        this.emit({ type: "mouseCursor", x: i.x, y: i.y, dragging: false });
        this.heldButtons.add(b);
        this.pressClickMods(i.clickMods ?? []);
        this.emit({ type: "button", button: b, down: true });
        return prevent;
    }

    /* ---- pointer move ---- */

    private onMove(i: PointerMoveInput): boolean {
        if (this.env.modalOpen) return false;
        if (i.kind === "mouse") {
            this.onMouseMove(i);
            return false;
        }
        const prev = this.pts.get(i.id);
        if (!prev) return false;
        this.pts.set(i.id, { x: i.x, y: i.y });

        if (this.pts.size >= 2) {
            this.onTwoFingerMove();
            return true;
        }

        // Single finger: the trackpad cursor, or the direct pointer.
        if (!this.startPt) return false;
        const movedDist = Math.hypot(i.x - this.startPt.x, i.y - this.startPt.y);
        if (!this.moved && movedDist > TOUCH_SLOP) {
            this.moved = true;
            this.cancelHold();
            if (this.holdArmed) this.startHoldDrag();
        }
        if (!this.moved) {
            this.lensMove(i, prev, movedDist);
            return false;
        }
        if (!this.gestureDirect) {
            this.relMove(i.x - prev.x, i.y - prev.y);
            this.lensMove(i, prev, movedDist);
        } else if (this.pressing) this.moveTo(i.x, i.y, false, true);
        else if (this.view.scale > 1) {
            // Direct touch: one finger pans a zoomed view, like a map.
            this.setView(panBy(this.view, i.x - prev.x, i.y - prev.y, this.env.pane, this.env.nat));
        } else this.moveTo(i.x, i.y, false);
        return true;
    }

    /**
     * The lens decides from the finger's speed, so it hears every trackpad move once the finger has left the
     * spot it touched by LENS_ENGAGE_PX (before the cursor itself starts moving at TOUCH_SLOP). Sent AFTER the
     * cursor has moved, so the lens is drawn where the cursor now is.
     */
    private lensMove(i: PointerMoveInput, prev: Point, movedDist: number): void {
        if (this.gestureDirect || movedDist <= LENS_ENGAGE_PX) return;
        const distance = Math.hypot(i.x - prev.x, i.y - prev.y);
        this.emit(i.at === undefined ? { type: "lens", distance } : { type: "lens", distance, at: i.at });
    }

    private onMouseMove(i: PointerMoveInput): void {
        // A move that reports no buttons down is proof the release happened, whether or
        // not its pointerup ever reached us.
        if (i.buttons === 0) this.releaseHeldMouseButtons();
        this.lastInputTouch = false;
        // A mouse points absolutely (the executor no-ops once the Pi is there).
        this.emit({ type: "setMouseOutput", absolute: true });
        // A held button means this move belongs to a drag that started on the picture, so
        // it keeps steering the target even once the host pointer has left, pinned to the
        // edge rather than thrown away. The button state is read from the event, not
        // assumed from where the pointer is.
        const dragging = i.buttons !== 0;
        this.moveTo(i.x, i.y, false, dragging);
        this.emit({ type: "mouseCursor", x: i.x, y: i.y, dragging });
        // When the target isn't showing a live picture (asleep / no signal), an absolute
        // position alone often won't wake it: mirror the movement as a clamped RELATIVE
        // nudge, which reliably does. Never with a real signal, or the cursor would double.
        if (!this.env.streamLive && this.env.windowFocused) {
            const dx = i.x - this.lastMoveX;
            const dy = i.y - this.lastMoveY;
            if (dx || dy) {
                this.emit({
                    type: "relative",
                    dx: Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, dx)),
                    dy: Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, dy)),
                });
            }
        }
        this.lastMoveX = i.x;
        this.lastMoveY = i.y;
    }

    private touchPoints(): [Point, Point] | null {
        const a = [...this.pts.values()];
        const p = a[0];
        const q = a[1];
        return p && q ? [p, q] : null;
    }

    private twoDist(): number {
        const pair = this.touchPoints();
        return pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
    }

    private centroid(): Point {
        let sx = 0;
        let sy = 0;
        this.pts.forEach((p) => {
            sx += p.x;
            sy += p.y;
        });
        return { x: sx / this.pts.size, y: sy / this.pts.size };
    }

    private onTwoFingerMove(): void {
        this.cancelHold();
        const d = this.twoDist();
        const c = this.centroid();
        const ts = this.twoStart;
        // Against the START of the gesture, the same way the single-finger branch measures against startPt.
        if (ts && Math.hypot(c.x - ts.cx, c.y - ts.cy) > MOVE_SLOP) ts.moved = true;
        // Decide ONCE whether this is a pinch or a two-finger drag, then stick to it. Doing
        // both every frame scrolled the target while you were only trying to zoom, because
        // no pinch keeps its centre still.
        if (ts && !ts.kind && ts.d0 > 0) {
            if (Math.abs(d / ts.d0 - 1) > PINCH_RATIO) ts.kind = "pinch";
            else if (Math.hypot(c.x - ts.cx, c.y - ts.cy) > TWO_FINGER_DRAG_PX) ts.kind = "drag";
        }
        const kind = ts ? ts.kind : "pinch";
        // The trackpad on an ABSOLUTE Pi knows exactly where the cursor is, so it zooms in
        // on the cursor and keeps it centred. Anywhere the cursor is unknown (direct touch,
        // relative HID) the zoom stays under the fingers.
        const onCursor = this.trackpadActive && !this.isRelative();
        if (kind === "pinch" && this.pinchDist > 0 && Math.abs(d / this.pinchDist - 1) > PINCH_STEP_EPSILON) {
            const at = onCursor ? this.virtualCursorClient : null;
            this.setView(
                zoomAround(this.view, at ? at.x : c.x, at ? at.y : c.y, this.view.scale * (d / this.pinchDist), this.env.pane, this.env.nat),
            );
            this.followCursorNow();
        }
        // Two-finger drag scrolls the target, except while zoomed with no cursor to follow:
        // then it moves the view, as does a pinch, so you can steer.
        if (!onCursor && this.view.scale > 1 && kind) {
            this.setView(panBy(this.view, c.x - this.pinchCx, c.y - this.pinchCy, this.env.pane, this.env.nat));
        } else if (kind === "drag") {
            this.scrollAcc += c.y - this.pinchCy;
            while (Math.abs(this.scrollAcc) >= WHEEL_STEP_PX) {
                this.emit({ type: "wheel", dx: 0, dy: this.scrollAcc > 0 ? 1 : -1 });
                this.scrollAcc += this.scrollAcc > 0 ? -WHEEL_STEP_PX : WHEEL_STEP_PX;
            }
        }
        this.pinchDist = d;
        this.pinchCx = c.x;
        this.pinchCy = c.y;
    }

    /* ---- pointer up ---- */

    private onUp(i: PointerUpInput): void {
        if (this.env.modalOpen) {
            // A modal swallows the release, so let go of anything the target is still
            // holding rather than leaving a button or modifier stuck down on it.
            this.releaseHeldMouseButtons();
            this.pts.delete(i.id);
            if (this.pts.size === 0) this.releasePressing();
            return;
        }
        if (!this.pts.has(i.id)) return;
        this.pts.delete(i.id);
        if (i.kind === "mouse") {
            const b = hidButtonFor(i.button);
            if (this.pts.size === 0) this.isMouseDown = false;
            if (!b) return; // nothing was pressed for it, so nothing to release
            this.emit({ type: "button", button: b, down: false });
            this.heldButtons.delete(b);
            this.releaseClickMods();
            return;
        }
        this.cancelHold();
        const wasArmed = this.disarmHold();
        // Two-finger tap (both up quickly, no drag) = right click.
        if (this.twoStart && this.pts.size === 1) {
            // A decided pinch or drag is never a tap, even a symmetrical pinch whose centre did not move.
            if (!this.twoStart.moved && !this.twoStart.kind && i.t - this.twoStart.t < TWO_FINGER_TAP_MS) this.tapClick("right");
            this.twoStart = null;
        }
        const wasPressing = this.pressing;
        if (this.pressing && this.pts.size === 0) this.releasePressing();
        if (this.startPt && this.startPt.id === i.id) {
            // Pure tap = left click; a hold released without moving = right click. Two quick
            // taps send two clicks, so the target OS forms the double-click. A cancelled touch
            // (the OS took it for a gesture) clicks nothing.
            if (!this.moved && !wasPressing && !i.cancelled) {
                const btn: HidButton = wasArmed ? "right" : "left";
                if (this.gestureDirect) this.pointAt(this.startPt.x, this.startPt.y, { kind: "click", button: btn });
                else this.tapClick(btn);
            }
            this.startPt = null;
            this.moved = false;
        }
    }

    /* ---- wheel ---- */

    private onWheel(i: PointerWheelInput): boolean {
        if (this.env.modalOpen) return false;
        const dy = i.deltaY < 0 ? 1 : -1;
        // Ctrl+wheel zooms the LOCAL view on the web, where there is no other way to get a
        // closer look. On the desktop it belongs to the target (zooming an editor or a
        // document over there), so the modifier is wrapped around the wheel explicitly:
        // bare modifiers are never forwarded, so the target would otherwise get a plain scroll.
        if (i.modifier !== "none") {
            if (!this.env.desktop) {
                this.setView(
                    zoomAround(
                        this.view,
                        i.x,
                        i.y,
                        this.view.scale * (i.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP),
                        this.env.pane,
                        this.env.nat,
                    ),
                );
                return true;
            }
            this.emit({ type: "wheel", dx: 0, dy, withMod: i.modifier === "meta" ? "MetaLeft" : "ControlLeft" });
            return true;
        }
        this.emit({ type: "wheel", dx: 0, dy });
        return true;
    }
}
