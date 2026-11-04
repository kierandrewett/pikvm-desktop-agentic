/**
 * The desktop app's bridge, if this page is running inside it. Everything that differs between
 * the desktop app and a browser asks here, so no component reads `window` for it.
 */

import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DesktopUpdate } from "@pikvm/contracts/desktop";
import { useEffect, useState } from "react";

/** The Electron preload's object, or undefined in a browser or on a phone. */
export function desktopBridge(): DesktopBridge | undefined {
    if (typeof window === "undefined") return undefined;
    return Reflect.get(window, DESKTOP_BRIDGE_KEY) as DesktopBridge | undefined;
}

export function isDesktopApp(): boolean {
    return desktopBridge() !== undefined;
}

/** Whether the window is maximised, kept current. False outside the desktop app. */
export function useWindowMaximised(): boolean {
    const [maximised, setMaximised] = useState(false);
    useEffect(() => {
        const win = desktopBridge()?.window;
        if (!win) return;
        let live = true;
        void win.isMaximised().then((value) => live && setMaximised(value));
        const off = win.onMaximiseChange(setMaximised);
        return () => {
            live = false;
            off();
        };
    }, []);
    return maximised;
}

/** The newest release, as the desktop app sees it. Undefined until the first answer, and always outside the desktop app. */
export function useDesktopUpdate(): DesktopUpdate | undefined {
    const [update, setUpdate] = useState<DesktopUpdate | undefined>(undefined);
    useEffect(() => {
        const bridge = desktopBridge();
        if (!bridge) return;
        let live = true;
        void bridge.checkForUpdate().then(
            (answer) => live && setUpdate(answer),
            () => live && setUpdate({ state: "unknown" }),
        );
        return () => {
            live = false;
        };
    }, []);
    return update;
}
