/**
 * Everything that makes the picture and answers touches on it, wired once and torn down once.
 *
 * Plain TypeScript over real elements, not a component: the video machine, the pointer machine
 * and the zoom transform all take events in the capture phase, call preventDefault
 * synchronously and run on timers of their own, none of which survives being re-created by a
 * render. React owns the markup and hands the elements over; this owns the behaviour and
 * publishes the few things the UI draws (signal, zoom, audio, the resolution toast).
 */

import {
    DEFAULT_ENV,
    IDENTITY_VIEW,
    applyViewTransform,
    attachPointerInput,
    createDomCommandSink,
    createPointerDriver,
    createStore,
    createVideoDom,
    createVideoDriver,
    measureNatural,
    measurePane,
    observePaneSize,
    type PointerDriver,
    type PointerEnv,
    type ReadableStore,
    type ScreenMode,
    type SignalState,
    type TouchHid,
    type TouchMode,
    type VideoDriver,
    type ViewTransform,
} from "@pikvm/kvm-engine";
import { createPainter, type Painter } from "./cursor-lens";
import type { FieldFocus } from "./field-focus";
import { createJanusBridge } from "./janus-stream";
import { createPointerExecutor } from "./pointer-executor";
import type { KvmSession } from "./session";
import { MIC_DEVICE_KEY, OUT_DEVICE_KEY, readDeviceChoice } from "../settings/local-prefs";

export interface PictureElements {
    readonly pane: HTMLElement;
    readonly img: HTMLImageElement;
    readonly video: HTMLVideoElement;
    readonly freeze: HTMLCanvasElement;
    readonly cursor: HTMLElement;
    readonly lens: HTMLCanvasElement;
}

export interface AudioState {
    /** A WebRTC session is carrying the picture, so there is audio to switch (MJPEG has none). */
    readonly available: boolean;
    readonly audioOn: boolean;
    readonly micOn: boolean;
    /** What the mic pip says: "On", "Off", "...", "Denied", "No mic", "Mic gone". */
    readonly micLabel: string;
    readonly micWarn: boolean;
}

export interface ResolutionToast {
    readonly text: string;
    readonly av: string;
    readonly show: boolean;
}

export interface PictureState {
    readonly signal: SignalState;
    readonly mode: ScreenMode;
    readonly webrtc: boolean;
    readonly scale: number;
    readonly audio: AudioState;
    readonly res: ResolutionToast;
    readonly fullUi: boolean;
    readonly hasFrame: boolean;
    /** Natural size of the picture, 0 before the first frame. */
    readonly width: number;
    readonly height: number;
}

export interface PicturePrefs {
    readonly touchMode: TouchMode;
    readonly touchHid: TouchHid;
    readonly dragLock: boolean;
    readonly modalOpen: boolean;
    readonly windowFocused: boolean;
}

export interface PictureController {
    readonly store: ReadableStore<PictureState>;
    readonly pointer: PointerDriver;
    readonly video: VideoDriver;
    /** Preferences that live outside the machines: the touch choices, drag-lock, dialogs, window focus. */
    setPrefs(prefs: Partial<PicturePrefs>): void;
    resetZoom(): void;
    toggleAudio(): void;
    toggleMic(): void;
    micDeviceChanged(): void;
    /** Show or hide the Pi's own UI over the picture: its stream is released while it is up. */
    setFullUi(on: boolean): void;
    /** Draw the speaker or mic level into `--vol` on this element, outside React. */
    bindMeter(kind: "audio" | "mic", el: HTMLElement | null): () => void;
    /** The pane's current size and the source's natural size, measured again. */
    remeasure(): void;
    dispose(): void;
}

export interface PictureOptions {
    readonly session: KvmSession;
    readonly elements: PictureElements;
    readonly focus: FieldFocus;
    readonly desktop: boolean;
    readonly prefs: PicturePrefs;
}

const RES_TOAST_MS = 2600;
const RES_FADE_MS = 300;
const AUDIO_REENABLE_MS = 3_600_000;
const METER_POLL_MS = 90;
const METER_IDLE_MS = 500;

/** The machine's environment is read-only to it; a patch is built up key by key. */
type EnvPatch = { -readonly [K in keyof PointerEnv]?: PointerEnv[K] };

const initialAudio: AudioState = { available: false, audioOn: true, micOn: false, micLabel: "Off", micWarn: false };

function randomKey(): string {
    return Math.random().toString(36).slice(2, 12);
}

export function createPictureController(options: PictureOptions): PictureController {
    const { session, elements, focus, desktop } = options;
    const { pane, img, video, freeze, cursor, lens } = elements;
    const { link, clock, keyboard } = session;

    const store = createStore<PictureState>({
        signal: "connecting",
        mode: "detecting",
        webrtc: false,
        scale: 1,
        audio: initialAudio,
        res: { text: "", av: "", show: false },
        fullUi: false,
        hasFrame: false,
        width: 0,
        height: 0,
    });
    const patch = (next: Partial<PictureState>): void => {
        const current = store.getState();
        for (const key of Object.keys(next) as Array<keyof PictureState>) {
            if (!Object.is(current[key], next[key])) {
                store.setState({ ...current, ...next });
                return;
            }
        }
    };
    const patchAudio = (next: Partial<AudioState>): void => patch({ audio: { ...store.getState().audio, ...next } });

    let prefs = options.prefs;
    const frame = (cb: () => void): number => requestAnimationFrame(cb);

    /* ---- the picture's source and size ---- */

    const activeSource = (): HTMLImageElement | HTMLVideoElement =>
        !video.classList.contains("hidden") && video.videoWidth > 0 ? video : img;

    /* ---- pointer ---- */

    const mouseModeOf = (absolute: boolean | null): PointerEnv["mouseMode"] =>
        absolute === null ? "unknown" : absolute ? "absolute" : "relative";

    const initialDevice = link.store.getState();
    const env: PointerEnv = {
        ...DEFAULT_ENV,
        touchMode: prefs.touchMode,
        touchHid: prefs.touchHid,
        dragLock: prefs.dragLock,
        modalOpen: prefs.modalOpen,
        windowFocused: prefs.windowFocused,
        desktop,
        hidOpen: initialDevice.link.open,
        mouseMode: mouseModeOf(initialDevice.device.mouse.absolute),
        relativeAvailable: initialDevice.device.mouse.outputs.includes("usb_rel"),
        streamLive: false,
        pane: measurePane(pane),
        nat: measureNatural(img),
    };

    let painter: Painter | null = null;
    const applyView = (view: ViewTransform): void => {
        applyViewTransform([img, video, freeze], view);
        patch({ scale: view.scale });
    };

    // The driver and the painter need each other (the painter reads the machine, the executor
    // feeds the painter), so the sink forwards through a late-bound reference.
    const painterProxy: Painter = {
        mouse: (x, y, d) => painter?.mouse(x, y, d),
        hideMouse: () => painter?.hideMouse(),
        trackpad: () => painter?.trackpad(),
        lens: (d) => painter?.lens(d),
        inputChanged: () => painter?.inputChanged(),
        dispose: () => painter?.dispose(),
    };
    const execute = createPointerExecutor({
        link,
        keyboard,
        clock,
        notify: session.notices.notify,
        painter: painterProxy,
        applyView,
    });
    const sink = createDomCommandSink({
        pane,
        focusKeyboard: () => focus.focus(),
        blurActive: () => {
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
        },
        next: execute,
    });
    const pointer = createPointerDriver({
        clock,
        sink,
        env,
        view: IDENTITY_VIEW,
        coarsePointer: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    });
    painter = createPainter({
        pane,
        cursor,
        lens,
        clock,
        machine: pointer.machine,
        source: activeSource,
        hidOpen: () => link.isOpen(),
        modalOpen: () => pointer.machine.environment.modalOpen,
        backgrounded: () => desktop && !pointer.machine.environment.windowFocused,
        frame,
        cancelFrame: (id) => cancelAnimationFrame(id),
    });

    const sendEnv = (patchEnv: EnvPatch): void => {
        pointer.send({ type: "env", env: patchEnv });
    };

    const remeasure = (): void => {
        const nat = measureNatural(activeSource());
        const current = pointer.machine.environment;
        const pane2 = measurePane(pane);
        const changed: EnvPatch = {};
        if (nat.w !== current.nat.w || nat.h !== current.nat.h) changed.nat = nat;
        if (
            pane2.left !== current.pane.left ||
            pane2.top !== current.pane.top ||
            pane2.width !== current.pane.width ||
            pane2.height !== current.pane.height
        ) {
            changed.pane = pane2;
        }
        if (Object.keys(changed).length > 0) sendEnv(changed);
        const source = activeSource();
        const w = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
        const h = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
        patch({ width: w, height: h });
    };

    const detachPointer = attachPointerInput({
        pane,
        driver: pointer,
        ignoreTarget: (target) => target instanceof Element && target.closest("[data-kvm-ui]") !== null,
        clickMods: (e) => {
            // Modifiers held on the host across a click, plus any armed on screen: on a touch
            // device arming is the only way to hold Ctrl at all. owned() leaves out what the user
            // is physically holding, which is already down and must not be released under them.
            const held: string[] = [];
            if (e.ctrlKey) held.push("ControlLeft");
            if (e.altKey) held.push("AltLeft");
            if (e.metaKey) held.push("MetaLeft");
            if (e.shiftKey) held.push("ShiftLeft");
            for (const armed of keyboard.takeArmed()) if (!held.includes(armed)) held.push(armed);
            return keyboard.modifiers.owned(held);
        },
    });
    // The pane can have moved without resizing (the keyboard sliding the visual viewport), so
    // its box is read again at the start of every gesture, ahead of the machine.
    const refreshAtDown = (): void => remeasure();
    pane.addEventListener("pointerdown", refreshAtDown, { capture: true });

    /* ---- the link feeds the machine ---- */

    let lastLink = link.store.getState();
    const offLink = link.store.subscribe(() => {
        const state = link.store.getState();
        const before = lastLink;
        lastLink = state;
        const next: EnvPatch = {};
        if (state.link.open !== before.link.open) {
            next.hidOpen = state.link.open;
            painter?.inputChanged();
        }
        const relativeAvailable = state.device.mouse.outputs.includes("usb_rel");
        if (relativeAvailable !== before.device.mouse.outputs.includes("usb_rel")) next.relativeAvailable = relativeAvailable;
        if (Object.keys(next).length > 0) sendEnv(next);
        if (state.device.mouse.absolute !== before.device.mouse.absolute) {
            pointer.send({ type: "mouseMode", mode: mouseModeOf(state.device.mouse.absolute) });
        }
    });

    /* ---- audio ---- */

    let audioOn = true;
    let micOn = false;
    let gestureArmed = false;
    let cancelReenable: (() => void) | null = null;
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Chromium|Android/.test(navigator.userAgent);

    const janus = createJanusBridge(
        video,
        () => readDeviceChoice(MIC_DEVICE_KEY).id,
        () => audioOn,
    );

    // Unmute without losing the picture: if the browser blocks it (no gesture), keep the muted
    // picture playing and unmute on the next interaction instead.
    const tryUnmute = (): void => {
        video.muted = false;
        void video.play().catch(() => {
            video.muted = true;
            void video.play().catch(() => {});
            armGestureUnmute();
        });
    };
    function armGestureUnmute(): void {
        if (gestureArmed) return;
        gestureArmed = true;
        const handler = (): void => {
            document.removeEventListener("pointerdown", handler, true);
            gestureArmed = false;
            if (audioOn && store.getState().webrtc && video.muted) tryUnmute();
        };
        document.addEventListener("pointerdown", handler, true);
    }

    const applySink = (): void => {
        const id = readDeviceChoice(OUT_DEVICE_KEY).id;
        const sinkable = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
        if (id && typeof sinkable.setSinkId === "function") void sinkable.setSinkId(id).catch(() => {});
    };

    const avSummary = (): string => {
        // Only a WebRTC session carries audio at all; audioOn is a desired state that survives a drop.
        if (!store.getState().webrtc) return "";
        return [audioOn ? "\u{1F50A}" : "", micOn ? "\u{1F399}" : ""].filter(Boolean).join(" ");
    };

    let resKey = "";
    let cancelResHide: (() => void) | null = null;
    let cancelResEmpty: (() => void) | null = null;
    const showResolution = (force = false): void => {
        const { width, height, webrtc, mode } = store.getState();
        if (width <= 16 || height <= 9) return; // no real frame yet
        const source = webrtc ? "HD \u00b7 WebRTC" : mode === "snapshot" ? "VNC" : "MJPEG";
        const key = `${width}x${height}/${source}`;
        if (!force && key === resKey) return;
        resKey = key;
        cancelResHide?.();
        cancelResEmpty?.();
        patch({ res: { text: `${width} \u00d7 ${height}  \u00b7  ${source}`, av: avSummary(), show: true } });
        cancelResHide = clock.setTimeout(() => {
            patch({ res: { ...store.getState().res, show: false } });
            cancelResEmpty = clock.setTimeout(() => {
                if (!store.getState().res.show) patch({ res: { text: "", av: "", show: false } });
            }, RES_FADE_MS);
        }, RES_TOAST_MS);
    };

    /* ---- video ---- */

    const dom = createVideoDom({
        elements: { pane, img, video, freezeCanvas: freeze },
        onSignal: (signal) => {
            patch({ signal, hasFrame: pane.classList.contains("has-frame") });
            sendEnv({ streamLive: signal === "live" });
        },
        onScreenMode: (mode) => patch({ mode }),
        onWebrtc: (event) => {
            if (event.type === "activated") {
                applySink();
                patchAudio({ available: true });
                patch({ webrtc: true });
                startMeters();
            } else if (event.type === "swapped") {
                remeasure();
                if (event.first) {
                    // Honour the audio preference now it is playing. Chrome unmutes at once;
                    // Safari pauses an un-gestured unmute, so it waits for the next tap.
                    if (audioOn && video.muted) {
                        if (isSafari) armGestureUnmute();
                        else tryUnmute();
                    }
                    showResolution(true);
                }
            } else {
                patchAudio({ available: false });
                patch({ webrtc: false });
                remeasure();
            }
        },
        // The link's own lifecycle binding (session.ts) already kicks the socket after a long
        // stay in the background and when the network returns; doing it here as well would
        // replace the fresh socket a second time.
        onHid: () => {},
    });
    const driver = createVideoDriver({
        clock,
        render: dom.render,
        janus: janus.port,
        streamKey: randomKey(),
        documentHidden: document.hidden,
    });
    const detachVideo = dom.attach(driver);

    const onFrameSize = (): void => {
        patch({ hasFrame: pane.classList.contains("has-frame") });
        remeasure();
        showResolution();
    };
    img.addEventListener("load", onFrameSize);
    video.addEventListener("loadedmetadata", onFrameSize);
    video.addEventListener("resize", onFrameSize);

    const detachResize = observePaneSize(pane, () => remeasure());
    window.addEventListener("resize", remeasure);
    window.visualViewport?.addEventListener("resize", remeasure);

    /* ---- meters: the live level behind the speaker and mic buttons ---- */

    const meters: Record<"audio" | "mic", Set<HTMLElement>> = { audio: new Set(), mic: new Set() };
    let meterRaf = 0;
    let meterTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPoll = 0;
    let speakerTarget = 0;
    let micTarget = 0;
    let speakerShown = 0;
    let micShown = 0;
    const setVol = (kind: "audio" | "mic", v: number): void => {
        for (const el of meters[kind]) el.style.setProperty("--vol", v.toFixed(3));
    };
    const meterTick = (): void => {
        meterRaf = 0;
        meterTimer = null;
        const bridge = janus.current();
        if (!store.getState().webrtc || !bridge) {
            setVol("audio", 0);
            setVol("mic", 0);
            speakerShown = micShown = speakerTarget = micTarget = 0;
            return; // the loop stops; the next activation restarts it
        }
        // Nothing to meter, or the window is hidden: drop to a cheap heartbeat.
        if ((!audioOn && !micOn) || document.hidden) {
            setVol("audio", 0);
            setVol("mic", 0);
            meterTimer = setTimeout(meterTick, METER_IDLE_MS);
            return;
        }
        const t = performance.now();
        if (!lastPoll || t - lastPoll > METER_POLL_MS) {
            lastPoll = t;
            void bridge.getAudioLevels().then((levels) => {
                if (levels.speaker !== null) speakerTarget = Math.min(1, levels.speaker * 2.4);
                if (levels.mic !== null) micTarget = Math.min(1, levels.mic * 2.4);
            });
        }
        // Rise instantly, fall slowly (about 0.4 s): a real VU meter.
        speakerShown = speakerTarget > speakerShown ? speakerTarget : Math.max(speakerTarget, speakerShown - 0.03);
        micShown = micTarget > micShown ? micTarget : Math.max(micTarget, micShown - 0.03);
        setVol("audio", audioOn ? speakerShown : 0);
        setVol("mic", micOn ? micShown : 0);
        meterRaf = frame(meterTick);
    };
    function startMeters(): void {
        if (!meterRaf && !meterTimer) meterRaf = frame(meterTick);
    }

    /* ---- the controller ---- */

    const scheduleReenable = (): void => {
        cancelReenable?.();
        // Someone who muted and forgot should not find the target silent a day later.
        cancelReenable = clock.setTimeout(() => {
            cancelReenable = null;
            if (!audioOn) controller.toggleAudio();
        }, AUDIO_REENABLE_MS);
    };

    const micFailure = (error: unknown): void => {
        const name = error instanceof Error ? error.name : "";
        const gone = name === "OverconstrainedError" || name === "NotFoundError" || name === "DevicesNotFoundError";
        // "Denied" is the user refusing the prompt; an unplugged pinned device is a different
        // fault, and sending someone to browser permissions to fix a headset they pulled out is wrong.
        if (gone && readDeviceChoice(MIC_DEVICE_KEY).id) {
            patchAudio({ micLabel: "Mic gone", micWarn: true });
            session.notices.notify({ text: "The chosen microphone is not connected. Pick another in Audio devices.", error: true });
            return;
        }
        patchAudio({ micLabel: gone ? "No mic" : "Denied", micWarn: true });
    };

    const controller: PictureController = {
        store,
        pointer,
        video: driver,
        setPrefs(next) {
            const before = prefs;
            prefs = { ...prefs, ...next };
            const envPatch: EnvPatch = {};
            if (prefs.touchMode !== before.touchMode) envPatch.touchMode = prefs.touchMode;
            if (prefs.touchHid !== before.touchHid) envPatch.touchHid = prefs.touchHid;
            if (prefs.dragLock !== before.dragLock) envPatch.dragLock = prefs.dragLock;
            if (prefs.modalOpen !== before.modalOpen) envPatch.modalOpen = prefs.modalOpen;
            if (prefs.windowFocused !== before.windowFocused) envPatch.windowFocused = prefs.windowFocused;
            if (Object.keys(envPatch).length > 0) sendEnv(envPatch);
            if (envPatch.touchMode !== undefined || envPatch.touchHid !== undefined) {
                // The Pi's mouse output follows the choice at once, not at the next touch.
                link.setMouseOutput(prefs.touchMode === "direct" || prefs.touchHid === "abs");
                painter?.trackpad();
                if (envPatch.touchMode === "direct") cursor.style.display = "none";
            }
            if (envPatch.modalOpen) {
                cursor.style.display = "none";
                pane.style.cursor = "";
            }
        },
        resetZoom() {
            pointer.send({ type: "view", view: IDENTITY_VIEW });
            applyView(IDENTITY_VIEW);
        },
        toggleAudio() {
            audioOn = !audioOn;
            video.muted = !audioOn;
            if (audioOn) void video.play().catch(() => {});
            janus.current()?.setAudio(audioOn);
            patchAudio({ audioOn });
            showResolution(true);
            startMeters();
            if (!audioOn) scheduleReenable();
            else {
                cancelReenable?.();
                cancelReenable = null;
            }
        },
        toggleMic() {
            const stream = janus.current();
            if (!stream) return;
            if (micOn) {
                micOn = false;
                stream.setMic(false);
                patchAudio({ micOn: false, micLabel: "Off", micWarn: false });
                showResolution(true);
                return;
            }
            patchAudio({ micLabel: "\u2026", micWarn: false });
            const devices = navigator.mediaDevices;
            if (!devices?.getUserMedia) {
                patchAudio({ micLabel: "No mic", micWarn: true });
                return;
            }
            // Pre-flight the permission prompt so a refusal can be named, through the same pinning
            // the real capture uses: it fails in exactly the cases the capture would.
            const pinned = readDeviceChoice(MIC_DEVICE_KEY).id;
            devices
                .getUserMedia({ audio: pinned ? { deviceId: { exact: pinned } } : true })
                .then((granted) => {
                    for (const track of granted.getTracks()) track.stop();
                    micOn = true;
                    stream.setMic(true);
                    patchAudio({ micOn: true, micLabel: "On", micWarn: false });
                    showResolution(true);
                    startMeters();
                })
                .catch(micFailure);
        },
        micDeviceChanged() {
            janus.current()?.micDeviceChanged();
            applySink();
        },
        setFullUi(on) {
            patch({ fullUi: on });
            driver.send({ type: "fullUi", on });
        },
        bindMeter(kind, el) {
            if (!el) return () => {};
            meters[kind].add(el);
            startMeters();
            return () => {
                meters[kind].delete(el);
            };
        },
        remeasure,
        dispose() {
            detachVideo();
            detachPointer();
            pane.removeEventListener("pointerdown", refreshAtDown, { capture: true });
            img.removeEventListener("load", onFrameSize);
            video.removeEventListener("loadedmetadata", onFrameSize);
            video.removeEventListener("resize", onFrameSize);
            detachResize();
            window.removeEventListener("resize", remeasure);
            window.visualViewport?.removeEventListener("resize", remeasure);
            offLink();
            cancelResHide?.();
            cancelResEmpty?.();
            cancelReenable?.();
            if (meterRaf) cancelAnimationFrame(meterRaf);
            clearTimeout(meterTimer ?? undefined);
            painter?.dispose();
            pointer.dispose();
            driver.dispose();
        },
    };
    driver.start();
    return controller;
}
