import type { Clock } from "../../clock/index";
import type { ModifierMirror } from "./modifier-mirror";

/**
 * The serialized key sender.
 *
 * Each chord is queued and sent to COMPLETION (modifiers down, settle, key down, hold, key up,
 * modifiers up, gap) before the next begins, so fast typing never interleaves modifiers, which
 * would flip a letter's case or drop it.
 *
 * Timing is not cosmetic, it is what the target's USB stack needs:
 *  - The target reads the HID gadget on a polling interval (5-10 ms is typical). A press whose
 *    down AND up both land between two polls is never seen at all. 22 ms spans several polls
 *    with room to spare and still allows ~36 keys/s, far beyond any human burst.
 *  - Modifiers get their own report, settled, BEFORE the key goes down. Sent in the same
 *    instant they can coalesce into one report, and some targets (BIOS, UEFI, KVM switches)
 *    then apply the key without the modifier.
 */
export interface KeyTiming {
    readonly holdMs: number;
    readonly gapMs: number;
    readonly modSettleMs: number;
    /** A runaway producer never grows the queue past this; the oldest chord is dropped. */
    readonly maxQueue: number;
}

export const defaultKeyTiming: KeyTiming = { holdMs: 22, gapMs: 4, modSettleMs: 6, maxQueue: 600 };

/** The target's Caps Lock as the link knows it. */
export interface CapsTarget {
    capsKnown(): boolean;
    capsOn(): boolean;
    noteCapsToggle(): void;
}

export interface KeyOutput {
    key(code: string, down: boolean): void;
}

export interface KeyQueueOptions {
    readonly clock: Clock;
    readonly output: KeyOutput;
    readonly caps: CapsTarget;
    readonly mirror: ModifierMirror;
    readonly timing?: Partial<KeyTiming>;
}

export interface KeyQueue {
    /**
     * Queue a chord. `letter` marks a key whose case Caps Lock inverts (A-Z): its Shift is
     * decided when the chord is PLAYED, against the target's Caps Lock at that moment, so a
     * Caps toggle queued ahead of it (the Caps key, or the host sync) is already accounted
     * for. Without it, a target with Caps on turned "Hello" into "hELLO".
     */
    chord(mods: readonly string[], code: string, shift?: boolean, letter?: boolean): void;
    /**
     * Run `cb` once every queued key has been pressed AND released. `chord` is
     * fire-and-forget (it queues and returns), so anything that has to happen AFTER a chord,
     * such as the next step of a macro, must wait for this instead.
     */
    afterKeys(cb: () => void): void;
    /** A chord is playing or waiting. */
    busy(): boolean;
    /** Chords waiting (not counting the one playing). */
    length(): number;
}

interface Op {
    mods: string[];
    readonly code: string;
    readonly shift?: boolean;
    readonly letter?: boolean;
}

export function createKeyQueue(options: KeyQueueOptions): KeyQueue {
    const { clock, output, caps, mirror } = options;
    const timing: KeyTiming = { ...defaultKeyTiming, ...options.timing };
    const queue: Op[] = [];
    let playing = false;
    let waiting: Array<() => void> = [];

    const drain = (): void => {
        const op = queue.shift();
        if (!op) {
            playing = false;
            const callbacks = waiting;
            waiting = [];
            for (const cb of callbacks) {
                try {
                    cb();
                } catch {
                    // One waiter failing must not strand the rest, or a macro stalls forever.
                }
            }
            return;
        }
        playing = true;
        // Unknown (no LED report yet) is treated as off: there is nothing better to go on.
        if (op.letter && op.shift !== (caps.capsKnown() && caps.capsOn())) op.mods = [...op.mods, "ShiftLeft"];
        if (op.code === "CapsLock") caps.noteCapsToggle();
        // A modifier the user is holding is already down on the target; pressing it again is
        // harmless but RELEASING it at the end of the chord would drop it while their finger
        // is still on the key. Leave those alone.
        const owned = mirror.owned(op.mods);
        for (const mod of owned) output.key(mod, true);
        clock.setTimeout(
            () => {
                output.key(op.code, true);
                clock.setTimeout(() => {
                    output.key(op.code, false);
                    for (let j = owned.length - 1; j >= 0; j--) {
                        const mod = owned[j];
                        if (mod !== undefined) output.key(mod, false);
                    }
                    clock.setTimeout(drain, timing.gapMs);
                }, timing.holdMs);
            },
            op.mods.length ? timing.modSettleMs : 0,
        );
    };

    return {
        chord(mods, code, shift = false, letter = false) {
            const m = [...mods];
            const alreadyShifted = m.includes("ShiftLeft") || m.includes("ShiftRight");
            // Shift can arrive twice, once from the caller's flag and once from an armed
            // on-screen Shift. Pressing the same physical key twice leaves it stuck down on
            // the target, so fold them into one.
            if (letter && !alreadyShifted) queue.push({ mods: m, code, shift, letter: true });
            else {
                if (shift && !alreadyShifted) m.push("ShiftLeft");
                queue.push({ mods: m, code });
            }
            if (queue.length > timing.maxQueue) queue.shift();
            if (!playing) drain();
        },
        afterKeys(cb) {
            if (!playing && queue.length === 0) {
                clock.setTimeout(cb, 0);
                return;
            }
            waiting.push(cb);
        },
        busy: () => playing,
        length: () => queue.length,
    };
}
