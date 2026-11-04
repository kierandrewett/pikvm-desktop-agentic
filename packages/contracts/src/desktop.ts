/**
 * What the Electron shell offers the web app. This is the whole of it: the page does its own
 * work, and the shell only does what a page cannot (own the window, reach the OS).
 *
 * The preload exposes one object under `window.pikvmDesktop`. Absent anywhere else (a browser,
 * a phone), which is how the app knows it is the desktop app. Plain types only: the preload
 * is bundled for Node and must not pull Effect in.
 */

/** The property the preload defines on `window`. */
export const DESKTOP_BRIDGE_KEY = "pikvmDesktop";

export type DesktopPlatform = "linux" | "darwin" | "win32";

export interface DesktopWindowApi {
    /** Minimise the window. */
    minimise(): void;
    /** Maximise, or restore when already maximised. */
    toggleMaximise(): void;
    /** Close the window (the app quits with it). */
    close(): void;
    /** Maximised now, for the first paint of the maximise/restore glyph. */
    isMaximised(): Promise<boolean>;
    /** Maximise or restore happened. Returns the unsubscribe. */
    onMaximiseChange(listener: (maximised: boolean) => void): () => void;
    /**
     * Enter or leave full screen. With `lockKeyboard` the OS shortcuts (Super, Alt+Tab) go to the
     * page while it is full screen, so they can be sent on to the target. Resolves to the state
     * that holds afterwards.
     */
    setFullscreen(on: boolean, options?: { readonly lockKeyboard?: boolean }): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
    /** The window itself gained or lost focus. Not the page's: a focused dialog still counts. */
    onFocusChange(listener: (focused: boolean) => void): () => void;
}

/** What became of a download the page started, once the OS is done with it. */
export interface DesktopDownload {
    readonly name: string;
    readonly state: "completed" | "cancelled" | "interrupted";
    /** Where it was saved. Empty unless it completed. */
    readonly path: string;
}

/** Whether a newer release than this app exists. `unknown` means GitHub could not be reached or answered oddly. */
export type DesktopUpdate =
    | { readonly state: "current"; readonly latest: string }
    | { readonly state: "available"; readonly latest: string; readonly url: string }
    | { readonly state: "unknown" };

export interface DesktopBridge {
    readonly platform: DesktopPlatform;
    /** The desktop app's version, from its package.json. */
    readonly version: string;
    /**
     * The OS draws the window controls (the macOS traffic lights), so the page leaves a gap for
     * them instead of drawing its own.
     */
    readonly nativeControls: boolean;
    readonly window: DesktopWindowApi;
    /**
     * Keep the display from sleeping (the OS's own "prevent display sleep", Electron's powerSaveBlocker)
     * while this window is in front, for a KVM left watching an install. Idempotent per window: true
     * twice holds one blocker, and the window's blocker is released when it closes. The page owns the
     * rule for when (visible only), as it does for the web wake lock.
     */
    keepDisplayAwake(on: boolean): void;
    /**
     * Pulse the taskbar or dock entry, for something that happened while the window was in the
     * background. Ignored while the window is focused; cleared the moment it is.
     */
    requestAttention(): void;
    /**
     * A download the page started has finished, been cancelled or failed. Clicking a download
     * link only hands the file to the OS (it may ask where to save, and the user may say no), so
     * "saved" is only true once this fires with `completed`.
     */
    onDownloadDone(listener: (download: DesktopDownload) => void): () => void;
    /** Open http(s) and mailto links in the user's browser or mail client. Other schemes are refused. */
    openExternal(url: string): Promise<void>;
    /**
     * Look up the latest release on GitHub (kept for an hour, so asking often is cheap). The app does not
     * install it: an update is a new download, or `flatpak update` for the Flatpak.
     */
    checkForUpdate(): Promise<DesktopUpdate>;
}
