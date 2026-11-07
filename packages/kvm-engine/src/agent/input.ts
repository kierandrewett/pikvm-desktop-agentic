import { systemClock, type Clock } from "../clock/clock";
import type { KeyboardLayout } from "../input/keyboard/char-map";
import { fracToNorm, type Frac, type Size } from "../view/geometry";
import { REL_CHUNK } from "../pointer/types";
import type { HidCommand, MouseButton } from "../target/wire";
import type { Chord } from "./chord";
import { planText, type TypingAnalysis } from "./typing";

/**
 * Agent-side input: deterministic moves, clicks, drags, wheel, typing and chords.
 *
 * This is not the gesture machine in `pointer/`, which interprets fingers. The agent already knows
 * exactly what it wants, so this only turns that into HID: an eased absolute move (or a sweep and
 * step on a relative target), a button with a short hold, keys with a short hold.
 *
 * Two promises the rest of the system leans on:
 *  - Whatever this puts down it lifts, whether the action finishes, fails or is aborted. A key or
 *    button left down on the target is far worse than an action that stopped half way.
 *  - An aborted action throws and sends nothing more, except the releases.
 */

/** The slice of the target link this needs. */
export interface AgentLink {
    send(command: HidCommand): void;
    isOpen(): boolean;
    isAbsolute(): boolean;
    isRelative(): boolean;
    capsOn(): boolean;
}

export interface AgentTiming {
    /** How long a click's button stays down. */
    readonly clickHoldMs: number;
    /** Between the clicks of a double or triple click. */
    readonly multiClickGapMs: number;
    /** After a move and before the button goes down, so hover effects have happened. */
    readonly settleMs: number;
    /** Between the steps of an eased move. */
    readonly moveStepMs: number;
    /** Finest and coarsest an eased move gets, and how far apart its steps are, in native pixels. */
    readonly moveMinSteps: number;
    readonly moveMaxSteps: number;
    readonly moveStepPx: number;
    /** In a drag: after the press and before the move, and after the move and before the release. */
    readonly dragHoldMs: number;
    readonly wheelGapMs: number;
    /** Per typed character: how long the key is down, and the gap after it. */
    readonly keyHoldMs: number;
    readonly keyGapMs: number;
    /** A chord: modifiers settle before the key, and the key is held this long. */
    readonly chordSettleMs: number;
    readonly chordHoldMs: number;
    /** Between chords of one call. */
    readonly chordGapMs: number;
    /** Between relative reports. */
    readonly relativeGapMs: number;
}

export const defaultAgentTiming: AgentTiming = {
    clickHoldMs: 45,
    multiClickGapMs: 90,
    settleMs: 40,
    moveStepMs: 8,
    moveMinSteps: 4,
    moveMaxSteps: 40,
    moveStepPx: 24,
    dragHoldMs: 100,
    wheelGapMs: 20,
    keyHoldMs: 35,
    keyGapMs: 25,
    chordSettleMs: 40,
    chordHoldMs: 60,
    chordGapMs: 80,
    relativeGapMs: 4,
};

export class AgentAbort extends Error {
    constructor(message = "aborted") {
        super(message);
        this.name = "AgentAbort";
    }
}

/** The link is closed, so nothing the agent sends would arrive. */
export class LinkClosed extends Error {
    constructor() {
        super("the HID socket to the target is closed");
        this.name = "LinkClosed";
    }
}

export interface AgentInputOptions {
    readonly link: AgentLink;
    /** The target's native resolution now. Only relative positioning needs it. */
    readonly native: () => Size;
    /** The target's keyboard layout now. */
    readonly layout: () => KeyboardLayout;
    readonly clock?: Clock;
    readonly timing?: Partial<AgentTiming>;
}

export interface AgentInput {
    /** Move the pointer to a point of the picture. */
    moveTo(to: Frac, signal: AbortSignal): Promise<void>;
    /** Move, then click `count` times (2 is a double click). */
    click(at: Frac, button: MouseButton, count: number, signal: AbortSignal): Promise<void>;
    /** Press at `from`, move to `to`, release. The button is released on every exit. */
    drag(from: Frac, to: Frac, button: MouseButton, signal: AbortSignal): Promise<void>;
    /** Move, then turn the wheel. Positive `dy` is down and positive `dx` is right, in notches. */
    scroll(at: Frac, dx: number, dy: number, signal: AbortSignal): Promise<void>;
    /** Type text through the layout. Throws before sending anything when a character has no key. */
    typeText(text: string, signal: AbortSignal): Promise<TypingAnalysis>;
    /** Press each chord in turn, modifiers last released. */
    chords(chords: readonly Chord[], signal: AbortSignal): Promise<void>;
    /** Lift every key and button this holds. Safe to call at any time, and never throws. */
    releaseAll(): void;
    /** What is down right now. */
    held(): { readonly keys: readonly string[]; readonly buttons: readonly MouseButton[] };
    /** Where the pointer was last put, or null if it has not been moved. */
    pointer(): Frac | null;
}

/** A character the layout has no key for. Nothing was sent. */
export class UnmappableText extends Error {
    readonly characters: readonly string[];
    constructor(characters: readonly string[]) {
        super(`these characters have no key on the target's layout: ${characters.map((c) => JSON.stringify(c)).join(" ")}`);
        this.name = "UnmappableText";
        this.characters = characters;
    }
}

/** Smoothstep: slow at both ends, so the pointer is seen to arrive. */
function ease(t: number): number {
    return t * t * (3 - 2 * t);
}

export function createAgentInput(options: AgentInputOptions): AgentInput {
    const { link } = options;
    const clock = options.clock ?? systemClock;
    const timing: AgentTiming = { ...defaultAgentTiming, ...options.timing };

    const keysDown: string[] = [];
    const buttonsDown: MouseButton[] = [];
    let at: Frac | null = null;

    const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
        if (signal.aborted) return Promise.reject(new AgentAbort());
        if (ms <= 0) return Promise.resolve();
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const onAbort = (): void => {
            cancel();
            reject(new AgentAbort());
        };
        const cancel = clock.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
        return promise;
    };

    /** Every send of NEW input goes through here; a closed socket stops the action instead of queueing it. */
    const send = (command: HidCommand): void => {
        if (!link.isOpen()) throw new LinkClosed();
        link.send(command);
    };

    const keyDown = (code: string): void => {
        send({ event_type: "key", event: { key: code, state: true } });
        keysDown.push(code);
    };
    const keyUp = (code: string): void => {
        const i = keysDown.lastIndexOf(code);
        if (i >= 0) keysDown.splice(i, 1);
        // A release is queued by the link even while it reconnects, and is never dropped as stale.
        link.send({ event_type: "key", event: { key: code, state: false } });
    };
    const buttonDown = (button: MouseButton): void => {
        send({ event_type: "mouse_button", event: { button, state: true } });
        buttonsDown.push(button);
    };
    const buttonUp = (button: MouseButton): void => {
        const i = buttonsDown.lastIndexOf(button);
        if (i >= 0) buttonsDown.splice(i, 1);
        link.send({ event_type: "mouse_button", event: { button, state: false } });
    };

    const releaseAll = (): void => {
        for (const button of [...buttonsDown].reverse()) {
            try {
                buttonUp(button);
            } catch {
                // a release that cannot be sent is retried by the link; nothing more to do here
            }
        }
        for (const code of [...keysDown].reverse()) {
            try {
                keyUp(code);
            } catch {
                // as above
            }
        }
    };

    /** Run an action, and lift whatever it left down however it ended. */
    const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
        try {
            return await action();
        } finally {
            releaseAll();
        }
    };

    const pxOf = (frac: Frac): { x: number; y: number } => {
        const native = options.native();
        return { x: frac.fx * native.width, y: frac.fy * native.height };
    };

    const relativeChunks = async (dx: number, dy: number, signal: AbortSignal): Promise<void> => {
        let rx = Math.round(dx);
        let ry = Math.round(dy);
        while (rx || ry) {
            const cx = Math.max(-REL_CHUNK, Math.min(REL_CHUNK, rx));
            const cy = Math.max(-REL_CHUNK, Math.min(REL_CHUNK, ry));
            send({ event_type: "mouse_relative", event: { delta: { x: cx, y: cy }, squash: false } });
            rx -= cx;
            ry -= cy;
            if (rx || ry) await sleep(timing.relativeGapMs, signal);
        }
    };

    /**
     * `holding` is a drag in progress: on a relative mouse the sweep would drag the target's content
     * to the corner, so the move steps from where the pointer is instead.
     */
    const moveTo = async (to: Frac, signal: AbortSignal, holding = false): Promise<void> => {
        if (signal.aborted) throw new AgentAbort();
        if (!link.isOpen()) throw new LinkClosed();
        if (link.isRelative() && holding && at) {
            const a = pxOf(at);
            const b = pxOf(to);
            await relativeChunks(b.x - a.x, b.y - a.y, signal);
            at = to;
            return;
        }
        if (link.isRelative()) {
            // A relative mouse has no position to read. Sweep to the top-left corner, which pins it,
            // and step from there. The target's pointer acceleration makes the landing approximate.
            const native = options.native();
            const reports = Math.ceil(Math.max(native.width, native.height) / REL_CHUNK) + 1;
            for (let i = 0; i < reports; i++) {
                send({ event_type: "mouse_relative", event: { delta: { x: -REL_CHUNK, y: -REL_CHUNK }, squash: false } });
                await sleep(timing.relativeGapMs, signal);
            }
            const target = pxOf(to);
            await relativeChunks(target.x, target.y, signal);
            at = to;
            return;
        }
        const from = at;
        const target = { x: fracToNorm(to.fx), y: fracToNorm(to.fy) };
        if (from) {
            const a = pxOf(from);
            const b = pxOf(to);
            const distance = Math.hypot(b.x - a.x, b.y - a.y);
            const steps = Math.max(
                timing.moveMinSteps,
                Math.min(timing.moveMaxSteps, Math.ceil(distance / timing.moveStepPx)),
            );
            const start = { x: fracToNorm(from.fx), y: fracToNorm(from.fy) };
            for (let i = 1; i < steps; i++) {
                const t = ease(i / steps);
                send({
                    event_type: "mouse_move",
                    event: {
                        to: {
                            x: Math.round(start.x + (target.x - start.x) * t),
                            y: Math.round(start.y + (target.y - start.y) * t),
                        },
                    },
                });
                await sleep(timing.moveStepMs, signal);
            }
        }
        send({ event_type: "mouse_move", event: { to: target } });
        at = to;
    };

    const pressButton = async (button: MouseButton, holdMs: number, signal: AbortSignal): Promise<void> => {
        buttonDown(button);
        await sleep(holdMs, signal);
        buttonUp(button);
    };

    const tapKey = async (code: string, holdMs: number, signal: AbortSignal): Promise<void> => {
        keyDown(code);
        await sleep(holdMs, signal);
        keyUp(code);
    };

    return {
        moveTo: (to, signal) => guarded(() => moveTo(to, signal)),

        click: (target, button, count, signal) =>
            guarded(async () => {
                await moveTo(target, signal);
                await sleep(timing.settleMs, signal);
                for (let i = 0; i < count; i++) {
                    if (i > 0) await sleep(timing.multiClickGapMs, signal);
                    await pressButton(button, timing.clickHoldMs, signal);
                }
            }),

        drag: (from, to, button, signal) =>
            guarded(async () => {
                await moveTo(from, signal);
                await sleep(timing.settleMs, signal);
                buttonDown(button);
                await sleep(timing.dragHoldMs, signal);
                await moveTo(to, signal, true);
                await sleep(timing.dragHoldMs, signal);
                buttonUp(button);
            }),

        scroll: (target, dx, dy, signal) =>
            guarded(async () => {
                await moveTo(target, signal);
                await sleep(timing.settleMs, signal);
                const notches = Math.max(Math.abs(Math.round(dx)), Math.abs(Math.round(dy)));
                const stepX = Math.sign(dx);
                const stepY = Math.sign(dy);
                for (let i = 0; i < notches; i++) {
                    // kvmd's wheel is positive UP; the agent's `dy` is positive DOWN, as on the web.
                    send({
                        event_type: "mouse_wheel",
                        event: {
                            delta: {
                                x: i < Math.abs(Math.round(dx)) ? stepX : 0,
                                y: i < Math.abs(Math.round(dy)) ? -stepY : 0,
                            },
                        },
                    });
                    if (i < notches - 1) await sleep(timing.wheelGapMs, signal);
                }
            }),

        typeText: (text, signal) =>
            guarded(async () => {
                // The whole text is planned first: a character with no key stops it before any key is sent.
                const plan = planText(text, options.layout(), link.capsOn());
                if (plan.unmappable.length) throw new UnmappableText(plan.unmappable);
                for (const stroke of plan.strokes) {
                    if (stroke.shift) keyDown("ShiftLeft");
                    await tapKey(stroke.code, timing.keyHoldMs, signal);
                    if (stroke.shift) keyUp("ShiftLeft");
                    await sleep(timing.keyGapMs, signal);
                }
                return { layout: plan.layout, sensitiveCharacters: plan.sensitiveCharacters };
            }),

        chords: (chords, signal) =>
            guarded(async () => {
                for (let n = 0; n < chords.length; n++) {
                    const chord = chords[n];
                    if (!chord) continue;
                    if (n > 0) await sleep(timing.chordGapMs, signal);
                    for (const mod of chord.mods) keyDown(mod);
                    await sleep(chord.key ? timing.chordSettleMs : 0, signal);
                    if (chord.key) await tapKey(chord.key, timing.chordHoldMs, signal);
                    else await sleep(timing.chordHoldMs, signal);
                    for (const mod of [...chord.mods].reverse()) keyUp(mod);
                }
            }),

        releaseAll,
        held: () => ({ keys: [...keysDown], buttons: [...buttonsDown] }),
        pointer: () => at,
    };
}
