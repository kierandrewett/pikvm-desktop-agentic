import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DesktopPlatform } from "@pikvm/contracts/desktop";
import { CHANNELS, VERSION_ARG } from "./channels";

/*
 * The only preload. It gives the page `window.pikvmDesktop` (see packages/contracts/src/desktop.ts)
 * and nothing else: every other thing the old preloads carried (native menus, fit-to-native,
 * taskbar pulses, theme relay) was for the legacy console and is gone with it.
 *
 * It runs sandboxed, so it cannot read package.json; the main process hands the version in as
 * a command-line argument.
 */

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
    const handler = (_event: unknown, value: T): void => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

const version = process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "";
const platform = process.platform as DesktopPlatform;

const bridge: DesktopBridge = {
    platform,
    version,
    nativeControls: platform === "darwin",
    window: {
        minimise: () => ipcRenderer.send(CHANNELS.minimise),
        toggleMaximise: () => ipcRenderer.send(CHANNELS.toggleMaximise),
        close: () => ipcRenderer.send(CHANNELS.close),
        isMaximised: () => ipcRenderer.invoke(CHANNELS.isMaximised),
        onMaximiseChange: (listener) => subscribe<boolean>(CHANNELS.maximiseChange, listener),
        setFullscreen: (on, options) => ipcRenderer.invoke(CHANNELS.setFullscreen, on, options?.lockKeyboard === true),
        isFullscreen: () => ipcRenderer.invoke(CHANNELS.isFullscreen),
        onFullscreenChange: (listener) => subscribe<boolean>(CHANNELS.fullscreenChange, listener),
        onFocusChange: (listener) => subscribe<boolean>(CHANNELS.focusChange, listener),
    },
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
