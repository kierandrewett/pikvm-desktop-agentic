import {
    DeskError,
    type ApprovalDecision,
    type ApprovalRequest,
    type Approver,
    type Desk,
    type DeskCall,
    type DeskSession,
    type FrameSize,
    type MouseButton,
    type Point,
    type Region,
    type ScreenInfo,
    type Shot,
    type WaitResult,
} from "../types";

/** A scripted approver: answers with `answer` (or what `decide` says) and keeps every request it was asked. */
export interface FakeApprover extends Approver {
    readonly requests: ApprovalRequest[];
    answer: ApprovalDecision;
    /** Settle a request later than it was made. Return a promise to hold the answer. */
    decide?: (request: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
}

export function createFakeApprover(answer: ApprovalDecision = "approved"): FakeApprover {
    const approver: FakeApprover = {
        requests: [],
        answer,
        async ask(request) {
            approver.requests.push(request);
            return approver.decide ? approver.decide(request) : approver.answer;
        },
    };
    return approver;
}

/** One call a FakeDesk saw, in order. */
export interface DeskCallRecord {
    readonly method: string;
    readonly args: readonly unknown[];
}

export interface FakeDesk extends Desk {
    readonly calls: DeskCallRecord[];
    /** What `open` reports as the screenshot age. */
    lookAgeMs: number | null;
    /** The next `open` throws this. */
    openError: DeskError | null;
    /** Runs inside every action; throw a DeskError to fail it. */
    onAction: ((method: string) => void | Promise<void>) | null;
    reference: FrameSize;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

export function createFakeDesk(): FakeDesk {
    const calls: DeskCallRecord[] = [];
    const record = (method: string, ...args: unknown[]): void => void calls.push({ method, args });
    const desk: FakeDesk = {
        calls,
        lookAgeMs: 1000,
        openError: null,
        onAction: null,
        reference: { width: 1280, height: 720 },
        async open(call: DeskCall, intent) {
            record("open", call.conversationId, intent);
            if (desk.openError) throw desk.openError;
            const session: DeskSession = {
                conversationId: call.conversationId,
                signal: call.signal,
                lookAgeMs: desk.lookAgeMs,
            };
            return session;
        },
        async info(): Promise<ScreenInfo> {
            record("info");
            return {
                reference: desk.reference,
                native: { width: 1920, height: 1080 },
                frameId: 1,
                mouse: "absolute",
                hidOnline: true,
                sourceOnline: true,
                control: "you",
            };
        },
        async screenshot(_s, region?: Region): Promise<Shot> {
            record("screenshot", region);
            await desk.onAction?.("screenshot");
            return {
                jpeg: JPEG,
                width: region ? 640 : desk.reference.width,
                height: region ? 360 : desk.reference.height,
                frameId: 1,
                reference: desk.reference,
                ...(region ? { region } : {}),
                mouse: "absolute",
                sourceOnline: true,
                hidOnline: true,
            };
        },
        async readText(_s, region?: Region) {
            record("readText", region);
            await desk.onAction?.("readText");
            return "hello";
        },
        async mouseMove(_s, to: Point) {
            record("mouseMove", to);
            await desk.onAction?.("mouseMove");
        },
        async click(_s, at: Point, button: MouseButton, count: number) {
            record("click", at, button, count);
            await desk.onAction?.("click");
        },
        async drag(_s, from: Point, to: Point, button: MouseButton) {
            record("drag", from, to, button);
            await desk.onAction?.("drag");
        },
        async scroll(_s, at: Point, dx: number, dy: number) {
            record("scroll", at, dx, dy);
            await desk.onAction?.("scroll");
        },
        async typeText(_s, text: string) {
            record("typeText", text);
            await desk.onAction?.("typeText");
        },
        async key(_s, chords: readonly string[]) {
            record("key", chords);
            await desk.onAction?.("key");
        },
        async wait(_s, ms: number, untilStable: boolean): Promise<WaitResult> {
            record("wait", ms, untilStable);
            return { waitedMs: ms, ...(untilStable ? { stable: true } : {}) };
        },
        approving(_s, tool, waiting) {
            record("approving", tool, waiting);
        },
        async power(_s, action) {
            record("power", action);
            await desk.onAction?.("power");
            return `Sent ATX ${action}.`;
        },
    };
    return desk;
}
