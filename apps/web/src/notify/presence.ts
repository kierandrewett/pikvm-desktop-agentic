/**
 * Tells the host whether the person is at this page, so a notification is not sent to a phone while they are looking at the screen.
 *
 * Only REAL input counts: a trusted DOM event (`isTrusted`) from the person's own keyboard, mouse, touch or pen. The HID the app sends to
 * the target (the jiggler's nudges, the computer-use agent, macros, anything replayed) never passes through this page as an event of
 * the person's, so it cannot be mistaken for them; an event a script dispatches is not trusted and is ignored.
 *
 * What is reported is a focus flag and two ages in ms (when the last real key press and the last significant pointer movement were,
 * counted back from now): no key, no coordinate, no text, no timestamp. It is sent when the person becomes active and then every
 * `REPORT_EVERY_MS` while they stay active and the page has focus; once, when the page loses focus or the person goes idle (so the host
 * stops holding notifications back at once); and never while the page is unfocused or idle. The host forgets a page that stops reporting.
 */

import type { WatchPresence } from "@pikvm/contracts/watch";

/** A pointer movement counts once the path it has travelled adds up to this many CSS px: one tiny nudge, a bump or a drift does not. */
export const POINTER_PATH_PX = 40;

/** The path travelled so far is forgotten after this long without a movement, so slow drift never adds up to a count. */
export const POINTER_RESET_MS = 1000;

/** While the page is focused and the person active, a report goes out this often. The host forgets a page after 12 s of silence. */
export const REPORT_EVERY_MS = 5000;

/** The person counts as active this long after their last real input. The same number is the host's (src/server/watch/limits.ts). */
export const ACTIVE_WINDOW_MS = 20_000;

export interface PresenceEnv {
    now(): number;
    /** The page is visible and has focus. */
    focused(): boolean;
    send(report: Omit<WatchPresence, "clientId">): void;
}

export interface PresenceReporter {
    /** A keydown. Counts only when `trusted`. */
    key(trusted: boolean): void;
    /** A pointer or touch position in CSS px. Counts as movement only when `trusted`. */
    move(x: number, y: number, trusted: boolean): void;
    /** A finger or pen on the screen: touch is the only way to use a phone, so contact is deliberate input and counts at once. */
    touch(trusted: boolean): void;
    /** Re-read the focus and the clock: after a focus change, and once a second. */
    evaluate(): void;
}

export function createPresenceReporter(env: PresenceEnv): PresenceReporter {
    let keyAt: number | null = null;
    let pointerAt: number | null = null;
    let path = 0;
    let last: { x: number; y: number; at: number } | null = null;
    /** The last state the host was told about: active and focused, or not. */
    let reportedActive = false;
    let reportedAt = Number.NEGATIVE_INFINITY;

    const ago = (at: number | null, now: number): number | null => (at === null ? null : Math.max(0, now - at));

    function report(now: number): void {
        env.send({ focused: env.focused(), keyboardAgoMs: ago(keyAt, now), pointerAgoMs: ago(pointerAt, now) });
        reportedAt = now;
    }

    function evaluate(): void {
        const now = env.now();
        const recent = (at: number | null): boolean => at !== null && now - at < ACTIVE_WINDOW_MS;
        const active = env.focused() && (recent(keyAt) || recent(pointerAt));
        if (active) {
            // Becoming active reports at once; staying active refreshes.
            if (!reportedActive || now - reportedAt >= REPORT_EVERY_MS) report(now);
            reportedActive = true;
        } else if (reportedActive) {
            // Blur or idle: one last report so the host stops holding notifications back, then silence.
            report(now);
            reportedActive = false;
        }
    }

    return {
        key(trusted) {
            if (!trusted) return;
            keyAt = env.now();
            evaluate();
        },
        move(x, y, trusted) {
            if (!trusted) return;
            const now = env.now();
            if (last && now - last.at <= POINTER_RESET_MS) path += Math.hypot(x - last.x, y - last.y);
            else path = 0;
            last = { x, y, at: now };
            if (path >= POINTER_PATH_PX) {
                pointerAt = now;
                evaluate();
            }
        },
        touch(trusted) {
            if (!trusted) return;
            pointerAt = env.now();
            evaluate();
        },
        evaluate,
    };
}

/** A random id for this page, 8 to 64 letters, digits, - and _ (what the host accepts). */
export function newClientId(): string {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === "function") return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
