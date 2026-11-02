/** The IPC channels between the preload and the main process. One list, so a channel cannot exist on one side only. */
export const CHANNELS = {
    minimise: "desktop:window:minimise",
    toggleMaximise: "desktop:window:toggle-maximise",
    close: "desktop:window:close",
    isMaximised: "desktop:window:is-maximised",
    setFullscreen: "desktop:window:set-fullscreen",
    isFullscreen: "desktop:window:is-fullscreen",
    openExternal: "desktop:open-external",
    requestAttention: "desktop:request-attention",
    downloadDone: "desktop:download-done",
    maximiseChange: "desktop:window:maximise-change",
    fullscreenChange: "desktop:window:fullscreen-change",
    focusChange: "desktop:window:focus-change",
} as const;

/** The command-line argument that carries the app version into the (sandboxed) preload. */
export const VERSION_ARG = "--pikvm-desktop-version=";
