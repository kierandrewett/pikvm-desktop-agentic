import { app } from "electron";

/**
 * Ask the OS to draw attention to a window's taskbar / dock entry.
 *
 * The console keeps sampling the remote picture while its window sits in the
 * background (see the screen-change detector in `views/console.js`); when
 * something meaningful moves over there we want the launcher icon to pulse, the
 * same way a chat app signals an unread message. Electron gives us two different
 * mechanisms for that:
 *
 *   - Linux / Windows: `flashFrame` sets the window's urgency hint, which GNOME,
 *     KDE and the Windows shell each render as a pulsing or highlighted taskbar
 *     entry that stays up until the window is focused.
 *   - macOS: there is no urgency hint, so the dock jiggle is `app.dock.bounce`.
 *     "critical" keeps bouncing until the app is activated, which is the same
 *     "still unattended" semantics the urgency hint has everywhere else.
 *
 * Both are cleared the moment the user focuses the window, so the cue never
 * outlives the thing that raised it.
 */

// Windows already carrying the focus-clears-attention listener.
const wired = new WeakSet<Electron.BrowserWindow>();
// The in-flight macOS dock bounce per window, so focus can cancel it.
const bounceIds = new WeakMap<Electron.BrowserWindow, number>();

/** Pulse the window's taskbar/dock entry. No-op if it is already focused. */
export function requestAttention(win: Electron.BrowserWindow): void {
    if (win.isDestroyed() || win.isFocused()) return;

    if (!wired.has(win)) {
        wired.add(win);
        win.on("focus", () => clearAttention(win));
    }

    if (process.platform === "darwin") {
        // A second bounce while one is still pending would stack; keep one.
        if (bounceIds.has(win)) return;
        const id = app.dock?.bounce("critical");
        if (typeof id === "number" && id >= 0) bounceIds.set(win, id);
        return;
    }
    win.flashFrame(true);
}

/** Stop any pulsing for this window. Safe to call when nothing is pulsing. */
export function clearAttention(win: Electron.BrowserWindow): void {
    const id = bounceIds.get(win);
    if (id !== undefined) {
        bounceIds.delete(win);
        app.dock?.cancelBounce(id);
    }
    if (!win.isDestroyed() && process.platform !== "darwin") win.flashFrame(false);
}
