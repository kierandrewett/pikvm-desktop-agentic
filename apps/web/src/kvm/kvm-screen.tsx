/**
 * The KVM screen: the target's picture with the controls to drive it, on a phone (the dock), in
 * a browser (the toolbar) and in the desktop app. It replaces the framed console.
 *
 * It composes; it decides nothing. The picture and the input wiring are the engine's, held by
 * the controller and the session, and this file only chooses the layout, keeps the small pieces
 * of UI state (which key rows are open, drag-lock) and feeds the preferences down.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopBridge } from "../host/desktop";
import { useAgentActivity } from "../agent/activity";
import { agentHoldsInput } from "@pikvm/contracts/api";
import { useMediaQuery } from "../app/viewport";
import { LoadError } from "../settings/pages/load-error";
import { TOUCH_HID_KEY, TOUCH_MODE_KEY, readTouchHid, readTouchMode, useStoredValue } from "../settings/local-prefs";
import { useActions } from "./actions";
import { AgentBanner, AgentPointer } from "./agent-banner";
import { askForAlertPermission } from "./attention";
import { SCREEN_ALERTS_KEY, readScreenAlerts, watchingForChange } from "./screen-alerts";
import { onAudioDevicesChanged } from "./audio-devices-event";
import { DialogHost } from "./dialog-host";
import type { DialogName } from "./dialog-seam";
import { Dock } from "./dock";
import { FirstRunProvider, useFirstRun } from "./first-run";
import { createFieldFocus } from "./field-focus";
import { KeyStrip } from "./key-rows";
import { KeyboardInput } from "./keyboard-input";
import { OcrPickerProvider } from "./ocr-picker";
import { FullUiFrame, Toast } from "./overlays";
import { Picture, usePictureState } from "./picture";
import type { PictureController, PicturePrefs } from "./picture-controller";
import { DOCK_QUERY, isDesktopApp, useInBackground, useIsFullscreen, useWakeLock } from "./platform";
import { KvmSessionProvider, useAppKvmSession, useKvmSession, useSessionReady } from "./session";
import { RecorderProvider, useKvmRecorder } from "./recorder/use-recorder";
import { Toolbar } from "./toolbar";
import { Welcome } from "./welcome";
import { KvmActiveProvider, useKvmActive } from "./active";
import { KvmLockedProvider } from "./locked";
import { useStore } from "./use-store";
import "./kvm.css";

export function KvmScreen() {
    const active = useKvmActive();
    const session = useKvmSession();
    const agent = useAgentActivity();
    const locked = agentHoldsInput(agent);
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
    const firstRun = useFirstRun();
    // No PiKVM yet: the stage is the welcome, and there is no target for the keyboard or the picture to belong to.
    const welcome = firstRun.phase === "needed";
    const stageRef = useRef<HTMLDivElement>(null);
    const recorder = useKvmRecorder(controller, stageRef, session);
    // Everything in the window that is not the picture's box (nav, toolbar, titlebar) is fixed-pixel, so the
    // shell adds back exactly this leftover around the native size.
    const fitWindow = useCallback(
        (force: boolean): void => {
            const stage = stageRef.current;
            const bridge = desktopBridge();
            if (!bridge || !stage || picture.width <= 16 || picture.height <= 9) return;
            bridge.window.fitNative({
                width: picture.width,
                height: picture.height,
                chromeWidth: Math.max(0, window.innerWidth - stage.clientWidth),
                chromeHeight: Math.max(0, window.innerHeight - stage.clientHeight),
                force,
            });
        },
        [picture.width, picture.height],
    );
    // Auto-size: when the target's resolution first arrives or changes, size the window to it. A manual
    // resize afterwards stands until the resolution changes again. While the window is maximised or full
    // screen the shell leaves it alone, so the fit is held and applied when the window is its own size again.
    useEffect(() => {
        const bridge = desktopBridge();
        if (!bridge || !active) return;
        let live = true;
        let stop: Array<() => void> = [];
        const settled = (): Promise<boolean> =>
            Promise.all([bridge.window.isMaximised(), bridge.window.isFullscreen()]).then(([max, full]) => !max && !full);
        void settled().then((free) => {
            if (!live) return;
            if (free) return fitWindow(false);
            const retry = (): void =>
                void settled().then((now) => {
                    if (!live || !now) return;
                    stop.forEach((off) => off());
                    stop = [];
                    fitWindow(false);
                });
            stop = [bridge.window.onMaximiseChange(retry), bridge.window.onFullscreenChange(retry)];
        });
        return () => {
            live = false;
            stop.forEach((off) => off());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new resolution refits, not a new callback identity
    }, [active, picture.width, picture.height]);
    const isFullscreen = useIsFullscreen();
    const background = useInBackground();
    // A phone suspends the page behind another app, so there is nothing running to watch the picture.
    const alertsAvailable = desktop || !dock;

    useSessionReady(session);
    // Held while the KVM is in front, not while it is merely mounted: it is mounted for the whole visit.
    useWakeLock(active);

    useEffect(() => {
        if (!active) return;
        // Safari's own pinch-zoom of the page would fight the picture's pinch.
        const stop = (e: Event): void => e.preventDefault();
        document.addEventListener("gesturestart", stop);
        return () => document.removeEventListener("gesturestart", stop);
    }, [active]);

    const modalOpen = open !== null;
    useEffect(() => {
        // A dialog takes the keyboard and the pointer: let go of whatever the target is holding.
        if (modalOpen) session.keyboard.releaseAll();
    }, [session, modalOpen]);

    useEffect(() => {
        // The agent taking the target: let go of every key and gesture held, as for a dialog.
        if (locked) session.keyboard.releaseAll();
    }, [session, locked]);

    useEffect(() => onAudioDevicesChanged(() => controller?.devicesChanged()), [controller]);

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
            active,
            touchMode,
            touchHid,
            dragLock,
            modalOpen,
            locked,
            windowFocused,
            watching: watchingForChange(alertsAvailable, alerts === "on", background),
        }),
        [active, touchMode, touchHid, dragLock, modalOpen, locked, windowFocused, alerts, alertsAvailable, background],
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
        <RecorderProvider value={recorder}>
        <KvmLockedProvider value={locked}>
        <OcrPickerProvider controller={controller}>
            <FirstRunProvider value={welcome}>
                <div className="kvm-screen" data-layout={dock ? "dock" : "wide"} data-desktop-app={desktop} data-agent-lock={locked || undefined} data-background={background || undefined}>
                    {dock ? null : (
                        <Toolbar
                            controller={controller}
                            actions={actions}
                            openDialog={openDialog}
                            keysOpen={keysOpen}
                            onKeys={setKeysOpen}
                            onFit={desktop && picture.width > 16 ? () => fitWindow(true) : null}
                        />
                    )}
                    {!dock && keysOpen ? <KeyStrip keyboard={session.keyboard} focus={focus} dragLock={dragLock} onDragLock={setDragLock} /> : null}
                    <div className="kvm-stage" ref={stageRef} data-agent={agent?.state}>
                        {firstRun.phase === "needed" ? (
                            <Welcome saved={firstRun.saved} />
                        ) : (
                            <>
                                <Picture session={session} focus={focus} desktop={desktop} prefs={prefs} onController={setController} />
                                <AgentPointer width={picture.width} height={picture.height} scale={picture.scale} />
                                <AgentBanner />
                                {fullUiOn ? <FullUiFrame onBack={() => toggleFullUi?.()} /> : null}
                                {/* Never over a live picture: the lists failing is then not what the user is looking at. */}
                                {firstRun.phase === "failed" && !picture.hasFrame ? (
                                    <div className="kvm-stage-notice">
                                        <LoadError message={firstRun.message} onRetry={firstRun.retry} />
                                    </div>
                                ) : null}
                            </>
                        )}
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
                    {welcome ? null : <KeyboardInput session={session} focus={focus} desktop={desktop} />}
                    <Toast session={session} />
                    <DialogHost session={session} />
                </div>
            </FirstRunProvider>
        </OcrPickerProvider>
        </KvmLockedProvider>
        </RecorderProvider>
    );
}

/**
 * The KVM as the shell hosts it: mounted from the start of the visit and kept mounted, so the
 * picture and the link are live the moment the tab is shown. `active` says whether it is the tab
 * in front; a provider above (a test's session) wins over the app's shared one.
 */
export function KvmPane({ active }: { active: boolean }) {
    const session = useAppKvmSession();
    return (
        <KvmSessionProvider session={session}>
            <KvmActiveProvider value={active}>
                <KvmScreen />
            </KvmActiveProvider>
        </KvmSessionProvider>
    );
}
