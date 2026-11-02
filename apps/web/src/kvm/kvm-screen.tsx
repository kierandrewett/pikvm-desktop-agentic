/**
 * The KVM screen: the target's picture with the controls to drive it, on a phone (the dock), in
 * a browser (the toolbar) and in the desktop app. It replaces the framed console.
 *
 * It composes; it decides nothing. The picture and the input wiring are the engine's, held by
 * the controller and the session, and this file only chooses the layout, keeps the small pieces
 * of UI state (which key rows are open, drag-lock) and feeds the preferences down.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMediaQuery } from "../app/viewport";
import { TOUCH_HID_KEY, TOUCH_MODE_KEY, readTouchHid, readTouchMode, useStoredValue } from "../settings/local-prefs";
import { useActions } from "./actions";
import { askForAlertPermission } from "./attention";
import { SCREEN_ALERTS_KEY, readScreenAlerts, watchingForChange } from "./screen-alerts";
import { onAudioDevicesChanged } from "./audio-devices-event";
import { DialogHost } from "./dialog-host";
import type { DialogName } from "./dialog-seam";
import { Dock } from "./dock";
import { createFieldFocus } from "./field-focus";
import { KeyStrip } from "./key-rows";
import { KeyboardInput } from "./keyboard-input";
import { OcrPickerProvider } from "./ocr-picker";
import { FullUiFrame, Toast } from "./overlays";
import { Picture, usePictureState } from "./picture";
import type { PictureController, PicturePrefs } from "./picture-controller";
import { DOCK_QUERY, isDesktopApp, useInBackground, useIsFullscreen, useWakeLock } from "./platform";
import { KvmSessionProvider, useKvmSession, useSessionReady } from "./session";
import { Toolbar } from "./toolbar";
import { useStore } from "./use-store";
import "./kvm.css";

export function KvmScreen() {
    const session = useKvmSession();
    const desktop = isDesktopApp();
    const touchLayout = useMediaQuery(DOCK_QUERY);
    const dock = touchLayout && !desktop;
    const focus = useMemo(() => createFieldFocus(session.clock), [session]);
    const [controller, setController] = useState<PictureController | null>(null);
    const [touchMode, setTouchMode] = useStoredValue(TOUCH_MODE_KEY, readTouchMode);
    const [touchHid, setTouchHid] = useStoredValue(TOUCH_HID_KEY, readTouchHid);
    const [alerts, setAlerts] = useStoredValue(SCREEN_ALERTS_KEY, readScreenAlerts);
    const [dragLock, setDragLock] = useState(false);
    const [keysOpen, setKeysOpen] = useState(false);
    const { open } = useStore(session.dialogs.store);
    const picture = usePictureState(controller);
    const isFullscreen = useIsFullscreen();
    const background = useInBackground();
    // A phone suspends the page behind another app, so there is nothing running to watch the picture.
    const alertsAvailable = desktop || !dock;

    useSessionReady(session);
    useWakeLock(true);

    useEffect(() => {
        // Safari's own pinch-zoom of the page would fight the picture's pinch.
        const stop = (e: Event): void => e.preventDefault();
        document.addEventListener("gesturestart", stop);
        return () => document.removeEventListener("gesturestart", stop);
    }, []);

    const modalOpen = open !== null;
    useEffect(() => {
        // A dialog takes the keyboard and the pointer: let go of whatever the target is holding.
        if (modalOpen) session.keyboard.releaseAll();
    }, [session, modalOpen]);

    useEffect(() => onAudioDevicesChanged(() => controller?.micDeviceChanged()), [controller]);

    const [windowFocused, setWindowFocused] = useState(true);
    useEffect(() => {
        // On the web the whole window is the target's; only the desktop app has a background state worth tracking.
        if (!desktop) return;
        const on = (): void => setWindowFocused(true);
        const off = (): void => setWindowFocused(false);
        window.addEventListener("focus", on);
        window.addEventListener("blur", off);
        return () => {
            window.removeEventListener("focus", on);
            window.removeEventListener("blur", off);
        };
    }, [desktop]);

    const prefs = useMemo<PicturePrefs>(
        () => ({
            touchMode,
            touchHid,
            dragLock,
            modalOpen,
            windowFocused,
            watching: watchingForChange(alertsAvailable, alerts === "on", background),
        }),
        [touchMode, touchHid, dragLock, modalOpen, windowFocused, alerts, alertsAvailable, background],
    );

    const openDialog = useCallback((name: DialogName) => session.dialogs.open(name), [session]);
    const fullUiOn = picture.fullUi;
    const toggleFullUi = useMemo(() => {
        // The Pi's UI is the picture's own stream in a frame: a snapshot target has nothing to frame.
        if (picture.mode === "snapshot" || !controller) return null;
        return () => {
            const next = !controller.store.getState().fullUi;
            controller.setFullUi(next);
            if (next) {
                // Two things must never type at the target at once.
                focus.release();
                session.keyboard.releaseAll();
            }
        };
    }, [controller, picture.mode, focus, session]);
    const actions = useActions({
        openDialog,
        toggleFullUi,
        fullUiOn,
        isFullscreen,
        screenAlerts: alertsAvailable
            ? {
                  on: alerts === "on",
                  toggle: () => {
                      const next = alerts === "on" ? "off" : "on";
                      setAlerts(next);
                      // The click is the gesture a browser wants before it shows its notification prompt.
                      if (next === "on" && !desktop) void askForAlertPermission();
                  },
              }
            : null,
    });

    return (
        <OcrPickerProvider controller={controller}>
            <div className="kvm-screen" data-layout={dock ? "dock" : "wide"} data-desktop-app={desktop}>
                {dock ? null : (
                    <Toolbar controller={controller} actions={actions} openDialog={openDialog} keysOpen={keysOpen} onKeys={setKeysOpen} />
                )}
                {!dock && keysOpen ? <KeyStrip keyboard={session.keyboard} focus={focus} dragLock={dragLock} onDragLock={setDragLock} /> : null}
                <div className="kvm-stage">
                    <Picture session={session} focus={focus} desktop={desktop} prefs={prefs} onController={setController} />
                    {fullUiOn ? <FullUiFrame onBack={() => toggleFullUi?.()} /> : null}
                </div>
                {dock ? (
                    <Dock
                        controller={controller}
                        focus={focus}
                        actions={actions}
                        touchMode={touchMode}
                        touchHid={touchHid}
                        onTouchMode={setTouchMode}
                        onTouchHid={setTouchHid}
                        dragLock={dragLock}
                        onDragLock={setDragLock}
                        openDialog={openDialog}
                    />
                ) : null}
                <KeyboardInput session={session} focus={focus} desktop={desktop} />
                <Toast session={session} />
                <DialogHost session={session} />
            </div>
        </OcrPickerProvider>
    );
}

/** The route: the screen over the app's one session. */
export function KvmRoute() {
    return (
        <KvmSessionProvider>
            <KvmScreen />
        </KvmSessionProvider>
    );
}
