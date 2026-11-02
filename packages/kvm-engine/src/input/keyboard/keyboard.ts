import type { Clock } from "../../clock/index";
import type { ReadableStore } from "../../store";
import { createArmedModifiers, type ArmedModifiers, type ArmedState } from "./armed-modifiers";
import { charToKey, isLetterKey, type KeyboardLayout } from "./char-map";
import { createKeyDeduper } from "./dedupe";
import { createHostCapsSync, type HostCapsTarget } from "./host-caps";
import { decide, type KeyEventLike } from "./key-chord";
import { createKeyQueue, type CapsTarget, type KeyOutput, type KeyTiming } from "./key-queue";
import { createModifierMirror, type ModifierMirror } from "./modifier-mirror";

/** What the keyboard needs from the kvmd link; `TargetLink` satisfies it. */
export type KeyboardTarget = KeyOutput & CapsTarget & HostCapsTarget;

export interface KeyboardOptions {
    readonly clock: Clock;
    readonly target: KeyboardTarget;
    readonly layout?: KeyboardLayout;
    readonly timing?: Partial<KeyTiming>;
}

/** What the DOM adapter should do with the event after `keydown`. */
export interface KeydownOutcome {
    readonly preventDefault: boolean;
}

export interface Keyboard {
    readonly armed: ReadableStore<ArmedState>;
    /**
     * Fires whenever the engine sent something that moves the target's caret away from the end of
     * what the soft-keyboard field holds (a bare key, a shortcut), so the field can start over.
     */
    onCaretMoved(listener: () => void): () => void;
    readonly modifiers: ModifierMirror;
    setLayout(layout: KeyboardLayout): void;

    /** Queue a chord. See KeyQueue.chord. */
    sendChord(mods: readonly string[], code: string, shift?: boolean, letter?: boolean): void;
    /** A bare key (with any armed sticky modifiers). The target's caret may move, so the soft-keyboard buffer starts over. */
    sendCode(code: string): void;
    /** A printable character, resolved to physical key + shift by the layout. Characters outside the layout are dropped. */
    sendChar(ch: string): void;
    /** A shortcut button, `"ControlLeft+KeyC"`: the named modifiers plus any armed ones, folded so one armed AND named is pressed once. */
    sendShortcut(spec: string): void;
    /** Run once every queued key has been pressed and released. */
    afterKeys(cb: () => void): void;
    /** Chords waiting or playing. */
    pending(): number;

    /** Act on a keydown from either keyboard path. `printable` is false for the hidden field, where beforeinput produces characters. */
    keydown(ev: KeyEventLike, printable: boolean): KeydownOutcome;
    keyup(ev: KeyEventLike): void;
    /** The beforeinput fallback for Enter: sent unless keydown already handled this key. */
    sendEnterFallback(): void;
    /** Whether a plain Backspace should be left to the field (see soft-keyboard): no modifier held, none armed. */
    isPlainBackspace(ev: KeyEventLike): boolean;

    /** Whether the current layout has a key for this character (what the soft-keyboard mirror counts as "typed"). */
    canType(ch: string): boolean;
    /** A bare Backspace, ignoring armed modifiers and leaving the soft-keyboard field alone (the mirror drives it). */
    sendBackspace(): void;
    /** Enter from the soft-keyboard field: armed modifiers apply and clear, the field is not reset. */
    sendNewline(): void;

    /** A modifier button was tapped: arm, lock or disarm. */
    tapModifier(code: string): void;
    /**
     * Hold the armed sticky modifiers around a mouse action, the way sendCode does around a
     * key. `act` receives a `release` to call when the action ends. A modifier the user is
     * also physically holding is left alone: pressing it again is harmless, releasing it at
     * the end would drop it while their finger is still down. A locked modifier stays armed.
     */
    withArmedModifiers(act: (release: () => void) => void): void;
    /** Let go of everything: focus loss, or a modal taking the keyboard. */
    releaseAll(): void;
}

export function createKeyboard(options: KeyboardOptions): Keyboard {
    const { clock, target } = options;
    let layout: KeyboardLayout = options.layout ?? "us";

    const mirror = createModifierMirror((code, down) => target.key(code, down));
    const queue = createKeyQueue({
        clock,
        output: target,
        caps: target,
        mirror,
        ...(options.timing ? { timing: options.timing } : {}),
    });
    const armed: ArmedModifiers = createArmedModifiers(clock);
    // Admitting a repeat only once the queue is nearly drained makes a held key track the drain rate.
    const deduper = createKeyDeduper(clock, () => queue.length() < 2);
    const hostCaps = createHostCapsSync({
        clock,
        target,
        toggleTarget: () => queue.chord([], "CapsLock", false),
    });
    const caretListeners = new Set<() => void>();
    const caretMoved = (): void => {
        for (const listener of [...caretListeners]) listener();
    };

    // Press sequence per modifier, so a deferred release can tell it has gone stale.
    const pressSeq = new Map<string, number>();
    const pressMod = (code: string): void => {
        pressSeq.set(code, (pressSeq.get(code) ?? 0) + 1);
        mirror.press(code);
    };
    /**
     * A modifier comes up only after the keys queued while it was held have gone out.
     * Releasing it at once let Win+Shift+S arrive as Win, Shift, then a bare S: the keyups
     * landed while the S chord was still waiting in the queue. A deferred release is dropped
     * if the key was pressed again meanwhile.
     */
    const releaseMod = (code: string): void => {
        if (queue.busy() || queue.length() > 0) {
            const seq = pressSeq.get(code);
            queue.afterKeys(() => {
                if (pressSeq.get(code) === seq) mirror.release(code);
            });
            return;
        }
        mirror.release(code);
    };

    const sendChord: Keyboard["sendChord"] = (mods, code, shift, letter) => queue.chord(mods, code, shift, letter);

    const sendCode = (code: string): void => {
        sendChord(armed.list(), code, false);
        armed.clear();
        caretMoved();
    };
    const sendChar = (ch: string): void => {
        const key = charToKey(ch, layout);
        if (!key) return;
        sendChord(armed.list(), key.code, key.shift, isLetterKey(key.code));
        armed.clear();
    };

    return {
        armed: armed.store,
        onCaretMoved(listener) {
            caretListeners.add(listener);
            return () => {
                caretListeners.delete(listener);
            };
        },
        modifiers: mirror,
        setLayout(next) {
            layout = next;
        },
        canType: (ch) => charToKey(ch, layout) !== null,
        sendBackspace: () => sendChord([], "Backspace", false),
        sendNewline() {
            sendChord(armed.list(), "Enter", false);
            armed.clear();
        },
        sendChord,
        sendCode,
        sendChar,
        sendShortcut(spec) {
            const parts = spec.split("+");
            const code = parts.pop();
            if (!code) return;
            const mods = parts.slice();
            for (const m of armed.list()) if (!mods.includes(m)) mods.push(m);
            sendChord(mods, code, false);
            armed.clear();
            caretMoved();
        },
        afterKeys: (cb) => queue.afterKeys(cb),
        pending: () => queue.length() + (queue.busy() ? 1 : 0),

        keydown(ev, printable) {
            hostCaps.observe(ev);
            const d = decide(ev, { armed: armed.list(), printable });
            if (d.kind === "ignore") {
                // A bare modifier rides the chord for typing, but it also has to be HELD on the
                // target so Ctrl+click and Ctrl+drag behave.
                if (d.why === "bare-modifier" && ev.code) pressMod(ev.code);
                return { preventDefault: false };
            }
            if (d.kind === "swallow") return { preventDefault: true };
            if (d.kind === "char") {
                // Printable keys carry no dedupe (a fast "aaa" must all land), so only the
                // repeat throttle applies.
                if (!ev.repeat || queue.length() < 2) sendChar(d.char);
                return { preventDefault: true };
            }
            if (deduper.dedupe(d.code, d.mods, !!ev.repeat)) sendChord(d.mods, d.code, false);
            armed.clear();
            return { preventDefault: true };
        },
        keyup(ev) {
            if (ev.code) releaseMod(ev.code);
            if (ev.code === "CapsLock") hostCaps.observe(ev);
        },
        sendEnterFallback() {
            // Match on the CODE, not the full chord, so a Shift+Enter that keydown already sent
            // is not followed by a bare Enter.
            if (deduper.recentlySent("Enter")) return;
            deduper.noteSent("Enter");
            sendCode("Enter");
        },
        isPlainBackspace: (ev) =>
            ev.key === "Backspace" && !ev.ctrlKey && !ev.altKey && !ev.metaKey && armed.list().length === 0,

        tapModifier: (code) => armed.tap(code),
        withArmedModifiers(act) {
            const mods = mirror.owned(armed.list());
            for (const m of mods) target.key(m, true);
            armed.clear();
            act(() => {
                for (let j = mods.length - 1; j >= 0; j--) {
                    const m = mods[j];
                    if (m !== undefined) target.key(m, false);
                }
            });
        },
        releaseAll() {
            mirror.releaseAll();
        },
    };
}
