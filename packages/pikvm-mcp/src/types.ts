/**
 * The two ports the PiKVM MCP server stands on, and the vocabulary they share.
 *
 * `Desk` is everything that touches the target: the HID link, the screenshots, who holds control.
 * `Approver` is the way to ask the person. Neither is imported from a host, so this package runs
 * unchanged in the desktop app, in the web host, and in a test with a fake of each.
 */

export type MouseButton = "left" | "right" | "middle";

/** A pixel of the REFERENCE frame: the downscaled picture of the whole screen the last screenshot returned. */
export interface Point {
    readonly x: number;
    readonly y: number;
}

export interface Region {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface FrameSize {
    readonly width: number;
    readonly height: number;
}

/**
 * Errors a model can act on. They reach it as the text of a failed tool result, never as a
 * protocol error, so it reads the reason and decides what to do next.
 */
export type DeskErrorCode =
    | "control_released"
    | "stale_frame"
    | "target_offline"
    | "another_conversation_holds_control"
    | "approval_denied"
    | "invalid_arguments"
    | "ocr_unavailable"
    | "power_disabled"
    | "unsupported_text"
    | "no_conversation";

export class DeskError extends Error {
    readonly code: DeskErrorCode;
    constructor(code: DeskErrorCode, message: string) {
        super(message);
        this.name = "DeskError";
        this.code = code;
    }
}

/** Who a call is for, and when to give up on it. */
export interface DeskCall {
    readonly conversationId: string;
    /** Aborts when the request goes away (the agent cancelled or the connection closed). */
    readonly signal: AbortSignal;
}

/**
 * One tool call's hold on the desk. Opening it is the single place the lease, the release state
 * and the stale-frame rule are checked, so a refusal happens BEFORE the person is asked anything.
 */
export interface DeskSession {
    readonly conversationId: string;
    /**
     * Aborts when the request goes away OR control is released (the person took over, Stop was
     * pressed, the lease timed out). On release its `reason` is a DeskError `control_released`.
     */
    readonly signal: AbortSignal;
    /** Milliseconds since this conversation last took a full screenshot; null if it never has. */
    readonly lookAgeMs: number | null;
}

export interface ScreenInfo {
    /** The reference frame: the coordinate space every tool argument uses. Null before the first screenshot. */
    readonly reference: FrameSize | null;
    readonly native: FrameSize | null;
    readonly frameId: number | null;
    readonly mouse: "absolute" | "relative" | "unknown";
    readonly hidOnline: boolean | null;
    readonly sourceOnline: boolean | null;
    /** Who holds control now. */
    readonly control: "you" | "another_conversation" | "released";
}

export interface Shot {
    readonly jpeg: Uint8Array;
    /** Size of the image returned. For a whole-screen shot this is the reference frame. */
    readonly width: number;
    readonly height: number;
    readonly frameId: number;
    /** The reference frame the coordinates use, which a zoom does not change. */
    readonly reference: FrameSize;
    /** Set for a zoom: the region of the reference frame it shows. */
    readonly region?: Region;
    readonly mouse: ScreenInfo["mouse"];
    readonly sourceOnline: boolean | null;
    readonly hidOnline: boolean | null;
}

/** A screenshot kept for the person to review, by the id the host's store gave it. */
export interface FrameRef {
    readonly id: string;
    readonly width: number;
    readonly height: number;
}

/**
 * Where the screenshots the agent takes are kept so the person can look at them afterwards, for the conversation the
 * call belongs to. The model gets the image in the tool result either way; this only adds a reference to it in the
 * result's `_meta`, under `FRAME_META_KEY`. Without one (a host that keeps nothing, or a picture it refuses) the results
 * go out without.
 */
export interface FrameSink {
    save(jpeg: Uint8Array, size: FrameSize): FrameRef | undefined;
}

/**
 * The `_meta` key of a tool result that names a kept frame. It is the chat server's key (`FRAME_META_KEY` in
 * `@pikvm/chat-protocol`); the two packages do not import each other, and a test on each side pins the string.
 */
export const FRAME_META_KEY = "chat/frame";

export interface WaitResult {
    readonly waitedMs: number;
    /** With `until_stable`: whether the screen settled before the time ran out. */
    readonly stable?: boolean;
}

/** Every method may throw DeskError; the handler turns it into a tool result. */
export interface Desk {
    open(call: DeskCall, intent: "observe" | "act"): Promise<DeskSession>;
    info(session: DeskSession): Promise<ScreenInfo>;
    screenshot(session: DeskSession, region?: Region): Promise<Shot>;
    readText(session: DeskSession, region?: Region): Promise<string>;
    mouseMove(session: DeskSession, to: Point): Promise<void>;
    click(session: DeskSession, at: Point, button: MouseButton, count: number): Promise<void>;
    drag(session: DeskSession, from: Point, to: Point, button: MouseButton): Promise<void>;
    scroll(session: DeskSession, at: Point, dx: number, dy: number): Promise<void>;
    typeText(session: DeskSession, text: string): Promise<void>;
    /** Chords in the notation `parseChord` reads. The handler has already parsed them, so they are well formed. */
    key(session: DeskSession, chords: readonly string[]): Promise<void>;
    wait(session: DeskSession, ms: number, untilStable: boolean): Promise<WaitResult>;
    /** Returns a sentence saying what happened. */
    power(session: DeskSession, action: "on" | "off" | "reset"): Promise<string>;
    /**
     * The handler is about to wait on the person (`waiting`), or is done waiting. The desk shows it
     * as "needs your approval" wherever it shows what the agent is doing.
     */
    approving?(session: DeskSession, tool: string, waiting: boolean): void;
}

export interface ApprovalRequest {
    readonly conversationId: string;
    /** The tool, without the server prefix: `key`, `drag`, `type_text`, `power`. */
    readonly tool: string;
    /** One line for the question: "Press Alt+F4 on the PiKVM?". */
    readonly title: string;
    /** What will be done, with the arguments in words. */
    readonly summary: string;
    /** Why this one asks, one short phrase per rule that matched. */
    readonly reasons: readonly string[];
    readonly arguments: Readonly<Record<string, unknown>>;
    /** Aborts when the person takes over, Stop is pressed or the call is cancelled; the ask is then abandoned. */
    readonly signal: AbortSignal;
}

/**
 * `unavailable` means nobody could be asked (no running response, no UI): the action is refused,
 * never queued. Nothing waits on a person who is not there.
 */
export type ApprovalDecision = "approved" | "denied" | "unavailable";

export interface Approver {
    ask(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalMode = "risky" | "always" | "never";

/** Settings the host may change while the server runs; read afresh on every call. */
export interface PikvmPolicy {
    readonly approval: ApprovalMode;
    /** Offer the `power` tool at all. Off by default. */
    readonly allowPower: boolean;
    /** Offer `read_text`. The target's kvmd must also have OCR, which the tool reports. */
    readonly ocr: boolean;
}

export const defaultPolicy: PikvmPolicy = { approval: "risky", allowPower: false, ocr: true };

/** What the KVM tab shows about the agent. */
export type AgentState = "idle" | "working" | "waiting_approval" | "released";

export interface AgentActivity {
    readonly state: AgentState;
    readonly conversationId?: string;
    /** The tool in flight, or the last one, without the server prefix. */
    readonly tool?: string;
    /** Where the agent's pointer is, as fractions of the picture, so it needs no resolution to draw. */
    readonly pointer?: { readonly fx: number; readonly fy: number };
    /** Why control ended, with `released`. */
    readonly reason?: "operator" | "stopped" | "lease_timeout";
    /** Epoch milliseconds. */
    readonly at: number;
}
