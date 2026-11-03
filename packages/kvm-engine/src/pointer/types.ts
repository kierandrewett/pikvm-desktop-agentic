// The pointer machine's vocabulary: what it is told (inputs, environment) and what
// it answers (commands). Everything is plain data, so the HID channel, the view and
// the UI consume the output without the machine knowing any of them.

import type { NaturalSize, Rect } from "../view/geometry";
import type { ViewTransform } from "../view/transform";

/* ---- tuning, all taken from the old console ---- */

/** A finger held still this long arms hold-to-drag (move -> drag, lift -> right click). */
export const HOLD_MS = 450;
/**
 * A finger holding still is never perfectly still. Below this a touch is a tap or a
 * hold and the cursor stays FROZEN, so a long press still lands its right click
 * where you aimed. 8px (the two-finger slop) was inside ordinary thumb wobble.
 */
export const TOUCH_SLOP = 16;
/** Two-finger travel below this still counts as a tap, and is measured from where the gesture began. */
export const MOVE_SLOP = 8;
/** Trackpad sensitivity on an absolute Pi: finger px -> picture travel. */
export const TRACKPAD_SENS = 0.9;
/** Relative HID: finger CSS pixels straight through; the target's own acceleration does the rest. */
export const REL_SENS = 1;
/** Bound on relative travel owed, so a switch that never comes cannot bank a screen-crossing jump. */
export const REL_OWE_MAX = 4000;
/** kvmd takes at most this much per relative report; a fast flick is several. */
export const REL_CHUNK = 127;
/** Finger travel per wheel step in a two-finger drag. */
export const WHEEL_STEP_PX = 22;
/** Distance change (relative to the start) that makes a two-finger gesture a pinch. */
export const PINCH_RATIO = 0.12;
/** Centroid travel that makes it a drag instead. Pinch is tested first. */
export const TWO_FINGER_DRAG_PX = 14;
/** Per-event distance change below which a pinch does not zoom (jitter). */
export const PINCH_STEP_EPSILON = 0.004;
/** Both fingers up within this, with no travel, is a two-finger tap = right click. */
export const TWO_FINGER_TAP_MS = 300;
/** How long a tap's button stays down; the executor of a `click` command applies it. */
export const CLICK_HOLD_MS = 45;
/** A queued "point then press" step older than this is stale and never sent. */
export const ABS_WAIT_MS = 2400;
/** When the queue is swept for stale steps after a push (a little after ABS_WAIT_MS). */
export const ABS_SWEEP_MS = 2500;
/** Queued steps are spaced past the 45 ms click hold, so one click is up before the next goes down. */
export const ABS_STEP_SPACING_MS = 90;
/** The relative wake-up nudge for a non-live target is clamped to this per axis. */
export const NUDGE_MAX = 30;
/** Moves are coalesced to one HID send per this interval (a display frame). */
export const FRAME_MS = 16;
/** Wheel zoom factor per notch, on the web (Ctrl/Cmd + wheel). */
export const WHEEL_ZOOM_STEP = 1.1;

/**
 * After this client last moved the pointer (a finger down or moving, a mouse moving, a wheel turning) it keeps the
 * cursor for this long: what another client moves in the meantime waits, and is drawn once this one has been still.
 * Long enough that a finger that lifts and lands again is one gesture; short enough that the hand-over is not felt.
 */
export const REMOTE_HOLD_MS = 500;

export type PointerKind = "mouse" | "touch" | "pen";
export type HidButton = "left" | "right" | "middle";
export type MouseMode = "absolute" | "relative" | "unknown";
export type TouchMode = "trackpad" | "direct";
export type TouchHid = "abs" | "rel";

/** What the machine reads from the world. Patch it with an `env` input when any of it changes. */
export interface PointerEnv {
    /** The user's choice: a drag moves a cursor (trackpad) or the touch IS the pointer (direct). */
    readonly touchMode: TouchMode;
    /** The trackpad's HID output; relative is for targets that ignore an absolute mouse. */
    readonly touchHid: TouchHid;
    /** What the Pi REPORTED. Unknown is not absolute. */
    readonly mouseMode: MouseMode;
    /** Whether the Pi offers a relative output to switch to. */
    readonly relativeAvailable: boolean;
    /** The drag-lock toggle: the next touch presses left and holds it. */
    readonly dragLock: boolean;
    /** Whether the HID socket is open (cursor painting only). */
    readonly hidOpen: boolean;
    /** Stream state is "live": a mouse over a sleeping target also sends a relative wake nudge. */
    readonly streamLive: boolean;
    /** False only while a desktop window is in the background; always true on web and phone. */
    readonly windowFocused: boolean;
    /** A dialog owns the pointer. */
    readonly modalOpen: boolean;
    /** The Electron app: affects focus hand-off and what Ctrl+wheel means. */
    readonly desktop: boolean;
    /** The pane (untransformed) in client pixels. */
    readonly pane: Rect;
    /** Intrinsic size of the picture, with the 16:9 fallback. */
    readonly nat: NaturalSize;
}

export const DEFAULT_ENV: PointerEnv = {
    touchMode: "trackpad",
    touchHid: "abs",
    mouseMode: "unknown",
    relativeAvailable: false,
    dragLock: false,
    hidOpen: true,
    streamLive: true,
    windowFocused: true,
    modalOpen: false,
    desktop: false,
    pane: { left: 0, top: 0, width: 800, height: 450 },
    nat: { w: 1600, h: 900 },
};

/* ---- inputs ---- */

interface Stamped {
    /** Milliseconds on the engine clock. */
    readonly t: number;
}

export interface PointerDownInput extends Stamped {
    readonly type: "down";
    readonly id: number;
    readonly kind: PointerKind;
    readonly x: number;
    readonly y: number;
    /** MouseEvent.button: 0 left, 1 middle, 2 right, 3/4 thumb pair. */
    readonly button: number;
    /**
     * Keys to hold down across a mouse click (host modifiers + armed sticky ones,
     * already de-duplicated against what the user is physically holding).
     */
    readonly clickMods?: readonly string[];
}

export interface PointerMoveInput extends Stamped {
    readonly type: "move";
    readonly id: number;
    readonly kind: PointerKind;
    readonly x: number;
    readonly y: number;
    /** MouseEvent.buttons bitmask; 0 on a mouse move is proof the release happened. */
    readonly buttons: number;
    /**
     * The event's own time (DOMHighResTimeStamp). Browsers deliver a frame's worth of moves together, so the
     * moment they are handled says nothing about how far apart the finger's samples were; the lens reads the
     * finger's speed off these. Only differences between them are used, never the value against the engine clock.
     */
    readonly at?: number;
}

export interface PointerUpInput extends Stamped {
    readonly type: "up";
    readonly id: number;
    readonly kind: PointerKind;
    readonly button: number;
    /** pointercancel: the OS took the touch for a gesture of its own. */
    readonly cancelled?: boolean;
}

export interface PointerWheelInput extends Stamped {
    readonly type: "wheel";
    readonly x: number;
    readonly y: number;
    readonly deltaY: number;
    /** Which of Ctrl/Cmd is down (Cmd wins when both are), or none. */
    readonly modifier: "none" | "control" | "meta";
}

export interface PointerEnterInput extends Stamped {
    readonly type: "enter";
    readonly kind: PointerKind;
}

export interface PointerLeaveInput extends Stamped {
    readonly type: "leave";
    readonly kind: PointerKind;
    readonly buttons: number;
}

/** The window lost focus or the picture was covered: let go of everything the target is holding. */
export interface PointerBlurInput extends Stamped {
    readonly type: "blur";
}

/** A timer the machine asked for has fired. */
export interface PointerTimerInput extends Stamped {
    readonly type: "timer";
    readonly id: string;
}

/** The frame the machine asked for has arrived: flush the coalesced move. */
export interface PointerFrameInput extends Stamped {
    readonly type: "frame";
}

/** The Pi reported its mouse mode (a `hid` event on the socket). */
export interface PointerMouseModeInput extends Stamped {
    readonly type: "mouseMode";
    readonly mode: MouseMode;
}

/** Environment changed; only the given keys. */
export interface PointerEnvInput extends Stamped {
    readonly type: "env";
    readonly env: Partial<PointerEnv>;
}

/** The view was changed from outside (zoom reset, resize re-clamp). */
export interface PointerViewInput extends Stamped {
    readonly type: "view";
    readonly view: ViewTransform;
}

/**
 * The shared cursor moved, in kvmd units. `own` is this client's own move coming back from the host: it moves
 * nothing and only settles that nothing newer from anybody else is waiting.
 */
export interface PointerRemoteInput extends Stamped {
    readonly type: "remote";
    readonly x: number;
    readonly y: number;
    readonly own: boolean;
}

export type PointerInput =
    | PointerDownInput
    | PointerMoveInput
    | PointerUpInput
    | PointerWheelInput
    | PointerEnterInput
    | PointerLeaveInput
    | PointerBlurInput
    | PointerTimerInput
    | PointerFrameInput
    | PointerMouseModeInput
    | PointerEnvInput
    | PointerViewInput
    | PointerRemoteInput;

/** An input before the driver stamps it with the clock. */
type Unstamped<T> = T extends unknown ? Omit<T, "t"> : never;
export type PointerInputInit = Unstamped<PointerInput>;

/* ---- commands ---- */

/** A raw button edge. */
export interface ButtonCommand {
    readonly type: "button";
    readonly button: HidButton;
    readonly down: boolean;
}

/**
 * A tap: the executor presses any armed sticky modifiers, presses the button, and
 * after CLICK_HOLD_MS releases both. Taps on a phone are the only way to Ctrl+click.
 */
export interface ClickCommand {
    readonly type: "click";
    readonly button: HidButton;
}

/** A modifier held across a mouse click, or released after it. */
export interface KeyCommand {
    readonly type: "key";
    readonly key: string;
    readonly down: boolean;
}

/** Absolute move in kvmd units (-32768..32767). */
export interface MoveCommand {
    readonly type: "move";
    readonly x: number;
    readonly y: number;
}

/** Relative move, already chunked to at most REL_CHUNK per axis. */
export interface RelativeCommand {
    readonly type: "relative";
    readonly dx: number;
    readonly dy: number;
}

export interface WheelCommand {
    readonly type: "wheel";
    readonly dx: number;
    readonly dy: number;
    /** A modifier to wrap around the wheel (Ctrl+scroll on the desktop belongs to the target). */
    readonly withMod?: "ControlLeft" | "MetaLeft";
}

/** Ask the Pi to switch its mouse output. The executor throttles and no-ops when already there. */
export interface SetMouseOutputCommand {
    readonly type: "setMouseOutput";
    readonly absolute: boolean;
}

/** The view transform changed; apply it to every picture element. */
export interface ViewCommand {
    readonly type: "view";
    readonly view: ViewTransform;
}

export type HoldCueCommand =
    | { readonly type: "holdCue"; readonly on: true; readonly x: number; readonly y: number; readonly direct: boolean }
    | { readonly type: "holdCue"; readonly on: false; readonly direct: boolean };

/** The desktop mouse's blob should be (re)painted for a pointer at this client point. */
export interface MouseCursorCommand {
    readonly type: "mouseCursor";
    readonly x: number;
    readonly y: number;
    readonly dragging: boolean;
}

export interface MouseCursorHideCommand {
    readonly type: "mouseCursorHide";
}

/** The trackpad's virtual cursor moved or appeared: repaint its blob from the machine's `vcur`. */
export interface TrackpadCursorCommand {
    readonly type: "trackpadCursor";
}

/**
 * The target's pointer is where another client put it: the machine's `vcur` has moved there. `show` says the pointer
 * is somebody else's, to be drawn as such where this client has no cursor of its own to move (the trackpad's blob is
 * that cursor; the desktop's own pointer is not the target's now). False once this client has moved it itself.
 */
export interface RemoteCursorCommand {
    readonly type: "remoteCursor";
    readonly show: boolean;
}

/**
 * Show the lens. With no `distance` a new touch began; with one it is this move's finger travel in px, for
 * the speed average, and `at` the move's own time when the input carried one (see PointerMoveInput.at).
 */
export type LensCommand = { readonly type: "lens" } | { readonly type: "lens"; readonly distance: number; readonly at?: number };

export interface CaptureCommand {
    readonly type: "capture";
    readonly id: number;
    readonly on: boolean;
}

/** Where keyboard focus should go: the hidden input on the web, nowhere on the desktop. */
export interface FocusCommand {
    readonly type: "focus";
    readonly target: "keyboard" | "none";
}

export interface NoticeCommand {
    readonly type: "notice";
    readonly message: string;
    readonly error: boolean;
}

/** Scheduling requests, which the driver fulfils against the injected clock and never forwards. */
export interface StartTimerCommand {
    readonly type: "startTimer";
    readonly id: string;
    readonly ms: number;
}
export interface CancelTimerCommand {
    readonly type: "cancelTimer";
    readonly id: string;
}
export interface RequestFrameCommand {
    readonly type: "requestFrame";
}

export type SchedulingCommand = StartTimerCommand | CancelTimerCommand | RequestFrameCommand;

export type OutputCommand =
    | ButtonCommand
    | ClickCommand
    | KeyCommand
    | MoveCommand
    | RelativeCommand
    | WheelCommand
    | SetMouseOutputCommand
    | ViewCommand
    | HoldCueCommand
    | MouseCursorCommand
    | MouseCursorHideCommand
    | TrackpadCursorCommand
    | RemoteCursorCommand
    | LensCommand
    | CaptureCommand
    | FocusCommand
    | NoticeCommand;

export type PointerCommand = OutputCommand | SchedulingCommand;

export interface PointerOutput {
    readonly commands: readonly PointerCommand[];
    /** Whether the DOM event's default action must be prevented. */
    readonly preventDefault: boolean;
}

/** The gesture the machine is in, derived from what it is tracking. */
export type PointerPhase =
    | "idle" // nothing down
    | "pending" // one finger down, not moved, hold not yet armed
    | "armed" // held still for HOLD_MS: a move now drags, a lift now right-clicks
    | "dragging" // one finger past the slop, or a button held by hold-to-drag / drag-lock
    | "two-finger" // two fingers down, pinch/drag not yet decided (or decided as a drag)
    | "pinching" // two fingers, decided as a pinch
    | "spent" // fingers remain from a multi-touch whose gesture is over; ignored until lifted
    | "mouse"; // a mouse button is down
