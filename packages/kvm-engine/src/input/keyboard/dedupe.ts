import type { Clock } from "../../clock/index";

/**
 * One physical press can reach us twice (keydown AND the beforeinput fallback that soft
 * keyboards need), so a same-key guard is needed. It has to be exact, though: keyed on the
 * code alone it also swallowed Shift+Enter typed straight after Enter, and every OS
 * auto-repeat faster than 60 ms while a key was held, which is most of them. So the identity
 * includes the modifiers, and a repeat event always passes (subject to the throttle).
 */
export const DEDUPE_MS = 60;

export interface KeyDeduper {
    /** True if this keydown should be sent. */
    dedupe(code: string, mods: readonly string[], repeat: boolean): boolean;
    /**
     * True if ANY chord on this physical key just went out. The beforeinput fallback uses this
     * so it never re-sends what keydown already handled with a modifier.
     */
    recentlySent(code: string): boolean;
    /** Record a send that did not go through `dedupe` (the beforeinput fallback), so a repeat of the same event is still caught. */
    noteSent(code: string): void;
}

/**
 * `admitRepeat` is the auto-repeat throttle. A held key repeats at the HOST's rate, which can
 * be as low as 15 ms and outrun the send queue: the target would then keep receiving the key
 * well after it was released. Admitting a repeat only once the queue is nearly drained makes
 * a held key track the drain rate instead of building a backlog.
 */
export function createKeyDeduper(clock: Clock, admitRepeat: () => boolean): KeyDeduper {
    let last = { code: "", id: "", at: Number.NEGATIVE_INFINITY };
    return {
        dedupe(code, mods, repeat) {
            if (repeat) return admitRepeat(); // genuine OS auto-repeat, not a double-fire
            const id = `${code}|${[...mods].sort().join("+")}`;
            const now = clock.now();
            if (last.id === id && now - last.at < DEDUPE_MS) return false;
            last = { code, id, at: now };
            return true;
        },
        recentlySent: (code) => last.code === code && clock.now() - last.at < DEDUPE_MS,
        noteSent(code) {
            last = { code, id: `${code}|`, at: clock.now() };
        },
    };
}
