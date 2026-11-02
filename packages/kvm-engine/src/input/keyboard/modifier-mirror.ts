/**
 * Mirrors the modifiers the user is physically holding onto the target.
 *
 * The subtlety is not the tracking, it is the interaction with the two paths that SYNTHESISE
 * modifiers: chords and clicks. Both must stand down for a key the user is already holding:
 * pressing it again is harmless, but releasing it at the end of a chord (or on pointerup)
 * drops it while their finger is still on the key, which is exactly the bug that made
 * Ctrl+click do nothing. `owned` answers "which of these are mine to press and release", and
 * is the only thing either path may act on.
 */
export interface ModifierMirror {
    isHeld(code: string): boolean;
    /** True if this call actually pressed it (false when already held or empty). */
    press(code: string): boolean;
    /** True if this call actually released it. */
    release(code: string): boolean;
    /** Release everything held; returns what was released. */
    releaseAll(): string[];
    /** The subset of `mods` a chord or click may press AND release itself. */
    owned(mods: readonly string[]): string[];
    /** Everything currently down, for assertions and diagnostics. */
    heldCodes(): string[];
}

/** `send(code, down)` performs the actual HID write. */
export function createModifierMirror(send: (code: string, down: boolean) => void): ModifierMirror {
    const held = new Set<string>();
    return {
        isHeld: (code) => held.has(code),
        press(code) {
            if (!code || held.has(code)) return false;
            held.add(code);
            send(code, true);
            return true;
        },
        release(code) {
            if (!code || !held.has(code)) return false;
            held.delete(code);
            send(code, false);
            return true;
        },
        releaseAll() {
            const codes = [...held];
            held.clear();
            for (const code of codes) send(code, false);
            return codes;
        },
        owned: (mods) => mods.filter((m) => !held.has(m)),
        heldCodes: () => [...held],
    };
}
