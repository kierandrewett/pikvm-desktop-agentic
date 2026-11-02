import type { Clock } from "../../clock/index";
import { createStore, type ReadableStore } from "../../store";

/**
 * Sticky on-screen modifiers. On a phone the drawer is the ONLY way to send a modifier at
 * all: tap Ctrl, then tap a key, and the chord goes out. A second tap within 350 ms locks the
 * modifier on, so it survives the key it was armed for.
 */
export const DOUBLE_TAP_MS = 350;

export interface ArmedState {
    /** Armed modifiers in the order they were armed. */
    readonly armed: readonly string[];
    /** The armed modifiers that were double-tapped and so stay armed after a key. */
    readonly locked: readonly string[];
}

export interface ArmedModifiers {
    readonly store: ReadableStore<ArmedState>;
    /** What the next key or click should carry. */
    list(): string[];
    isArmed(code: string): boolean;
    isLocked(code: string): boolean;
    /** A tap on the modifier's button: arm, lock (double-tap) or disarm. */
    tap(code: string): void;
    /** After a key or click consumed them: drop every armed modifier that is not locked. */
    clear(): void;
    /** Drop everything, locked or not (focus loss, a modal taking the keyboard). */
    reset(): void;
}

export function createArmedModifiers(clock: Clock): ArmedModifiers {
    const armed = new Set<string>();
    const locked = new Set<string>();
    const lastTap = new Map<string, number>();
    const store = createStore<ArmedState>({ armed: [], locked: [] });
    const publish = (): void => store.setState({ armed: [...armed], locked: [...locked] });

    return {
        store,
        list: () => [...armed],
        isArmed: (code) => armed.has(code),
        isLocked: (code) => locked.has(code),
        tap(code) {
            const now = clock.now();
            if (armed.has(code)) {
                const previous = lastTap.get(code);
                if (previous !== undefined && now - previous < DOUBLE_TAP_MS && !locked.has(code)) {
                    locked.add(code);
                } else {
                    armed.delete(code);
                    locked.delete(code);
                }
            } else {
                armed.add(code);
            }
            lastTap.set(code, now);
            publish();
        },
        clear() {
            let changed = false;
            for (const code of [...armed]) {
                if (locked.has(code)) continue;
                armed.delete(code);
                changed = true;
            }
            if (changed) publish();
        },
        reset() {
            if (armed.size === 0 && locked.size === 0) return;
            armed.clear();
            locked.clear();
            publish();
        },
    };
}
