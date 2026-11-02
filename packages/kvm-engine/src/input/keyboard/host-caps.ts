import type { Clock } from "../../clock/index";
import type { KeyEventLike } from "./key-chord";

/**
 * Keep the target's Caps Lock where the host's is.
 *
 * Key events carry the host's Caps Lock state, but a soft keyboard reports false there
 * whatever is going on, so a plain "make the target match" would undo every tap of the
 * on-screen Caps key on a phone. So only EVIDENCE of the host's state is acted on, and only
 * from events that look like a real keyboard (a physical `code`, no IME keyCode 229, a known
 * key):
 *   - a change since the last such event (the host's Caps Lock was pressed);
 *   - the first reading, only when it is ON (a soft keyboard never says so).
 * One Caps Lock press then goes out ahead of whatever this key sends, so the target agrees
 * before the next letter lands.
 *
 * The Caps Lock key itself is forwarded as a chord by the keydown path. Platforms disagree on
 * whether its own events report the state before or after the press (and macOS sends only a
 * keyup when it turns OFF), so instead of trusting that event, the two are compared once the
 * target's LED has answered.
 */
export const CAPS_RECONCILE_MS = 1400;

export interface HostCapsTarget {
    capsKnown(): boolean;
    capsOn(): boolean;
    capsPending(): boolean;
}

export interface HostCapsSync {
    /** Feed every keydown and the Caps Lock keyup. */
    observe(ev: KeyEventLike): void;
}

export interface HostCapsOptions {
    readonly clock: Clock;
    readonly target: HostCapsTarget;
    /** Queue one Caps Lock press on the target. */
    readonly toggleTarget: () => void;
}

export function createHostCapsSync(options: HostCapsOptions): HostCapsSync {
    const { clock, target, toggleTarget } = options;
    let hostCaps: boolean | null = null;
    let cancelReconcile: (() => void) | null = null;

    return {
        observe(ev) {
            if (typeof ev.getModifierState !== "function") return;
            if (!ev.code || ev.isComposing || ev.keyCode === 229 || ev.key === "Unidentified") return;
            const previous = hostCaps;
            const now = !!ev.getModifierState("CapsLock");
            hostCaps = now;
            if (ev.code === "CapsLock") {
                cancelReconcile?.();
                cancelReconcile = clock.setTimeout(() => {
                    cancelReconcile = null;
                    if (hostCaps === null || !target.capsKnown() || target.capsPending()) return;
                    if (hostCaps !== target.capsOn()) toggleTarget();
                }, CAPS_RECONCILE_MS);
                return;
            }
            if (previous === null ? !now : previous === now) return;
            if (!target.capsKnown() || target.capsPending()) return;
            if (now !== target.capsOn()) toggleTarget();
        },
    };
}
