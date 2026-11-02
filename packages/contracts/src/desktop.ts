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
    /** Open http(s) and mailto links in the user's browser or mail client. Other schemes are refused. */
    openExternal(url: string): Promise<void>;
}
