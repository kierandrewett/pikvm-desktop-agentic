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
import { attentionSink } from "./attention";
import { createPainter, type Painter } from "./cursor-lens";
import type { FieldFocus } from "./field-focus";
import { onNextActivation } from "./gesture-unmute";
import { buzz } from "./haptics";
import { createJanusBridge } from "./janus-stream";
import { createScreenAlerts } from "./screen-alerts";
import { createPointerExecutor } from "./pointer-executor";
import type { KvmSession } from "./session";
import { CAM_DEVICE_KEY, MIC_DEVICE_KEY, OUT_DEVICE_KEY, readDeviceChoice } from "../settings/local-prefs";
import { collectDevices } from "../settings/pages/audio-devices";
import {
    CAMERA_LABELS,
    CAMERA_WARNINGS,
    cameraBlock,
    cameraConstraints,
    cameraOpenable,
    classifyCameraError,
    readCameraChoice,
    type CameraSent,
    type CameraDevices,
    type CameraSupport,
} from "./camera";

export interface PictureElements {
    readonly pane: HTMLElement;
    readonly img: HTMLImageElement;
    readonly video: HTMLVideoElement;
    readonly freeze: HTMLCanvasElement;
    readonly cursor: HTMLElement;
    readonly lens: HTMLCanvasElement;
    /** Somebody else's pointer, where this page has no cursor of its own to move. */
    readonly remote: HTMLElement;
}

export interface AudioState {
    /** A WebRTC session is carrying the picture, so there is audio to switch (MJPEG has none). */
    readonly available: boolean;
    readonly audioOn: boolean;
    /** Sound is wanted but the browser has not allowed it yet: it waits for a tap (Safari, K38). */
    readonly blocked: boolean;
    readonly micOn: boolean;
    /** What the mic pip says: "On", "Off", "...", "Denied", "No mic", "Mic gone". */
    readonly micLabel: string;
    readonly micWarn: boolean;
    /** What the Pi said about its camera (the `cam` feature, PiKVM V3/V4 with `ucamera`). The camera control is always drawn; this decides whether it can be turned on. */
    readonly camSupport: CameraSupport;
    readonly camOn: boolean;
    /** What the camera pip says: "On", "Off", "...", "Denied", "No camera", "Camera gone", "In use", "Stopped". */
    readonly camLabel: string;
    readonly camWarn: boolean;
    /** What the camera sends, as the browser really opened it (not as asked), while it is on and the session carries it. */
    readonly camSent: CameraSent | null;
    /** The browser's camera list as last read: "none" is "No camera" before anything is pressed, "denied" is a blocked permission (no camera is listed then). */
    readonly camDevices: CameraDevices;
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
    /**
     * The KVM is the tab in front. The picture keeps streaming while it is not (so it is live the
     * moment it returns), but nothing the person does elsewhere may move the pointer.
     */
    readonly active: boolean;
    readonly touchMode: TouchMode;
    readonly touchHid: TouchHid;
    readonly dragLock: boolean;
    readonly modalOpen: boolean;
    /** The agent holds the target's keyboard and mouse: no gesture reaches it. */
    readonly locked: boolean;
    readonly windowFocused: boolean;
    /** The window is in the background and the screen should be watched: its taskbar entry (desktop app) or tab (browser) is flagged when the picture changes. */
    readonly watching: boolean;
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
    toggleCam(): void;
    /** A device choice changed in Audio devices: the live session pins the new microphone and camera, and the speaker follows. */
    devicesChanged(): void;
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

const initialAudio: AudioState = {
    available: false,
    audioOn: true,
    blocked: false,
    micOn: false,
    micLabel: "Off",
    micWarn: false,
    camSupport: "unknown",
    camOn: false,
    camLabel: CAMERA_LABELS.off,
    camWarn: false,
    camSent: null,
    camDevices: "unknown",
};

/** The pointer machine treats "a dialog is open" and "another tab is in front" the same way: it lets go of what it holds and takes no gestures; so does the agent holding the target. */
const pointerBlocked = (p: Pick<PicturePrefs, "modalOpen" | "active" | "locked">): boolean => p.modalOpen || !p.active || p.locked;

function randomKey(): string {
    return Math.random().toString(36).slice(2, 12);
}

export function createPictureController(options: PictureOptions): PictureController {
    const { session, elements, focus, desktop } = options;
    const { pane, img, video, freeze, cursor, remote, lens } = elements;
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
        modalOpen: pointerBlocked(prefs),
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
        remote: (show) => painter?.remote(show),
        lens: (d, at) => painter?.lens(d, at),
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
        cue: () => buzz("light"),
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
        remote,
        lens,
        clock,
        machine: pointer.machine,
        source: activeSource,
        hidOpen: () => link.isOpen(),
        // What the shared cursor asks: whether a dialog or another tab hides it. The agent holding the target blocks gestures but must not hide its own pointer.
        modalOpen: () => pointerBlocked({ ...prefs, locked: false }),
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

    /* ---- the shared cursor ---- */

    // Where the target's pointer is, whoever moved it. The machine decides whether this page takes it now (idle) or
    // later (it is moving the pointer itself), and never sends it on: this page only ever draws what it is told.
    const offCursor = session.cursor.subscribe((event) => {
        pointer.send({ type: "remote", x: event.x, y: event.y, own: event.own });
    });

    /* ---- audio ---- */

    let audioOn = true;
    let micOn = false;
    let camOn = false;
    let gestureArmed = false;
    let cancelGestureUnmute: (() => void) | null = null;
    let cancelReenable: (() => void) | null = null;
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Chromium|Android/.test(navigator.userAgent);

    const janus = createJanusBridge(video, {
        micDeviceId: () => readDeviceChoice(MIC_DEVICE_KEY).id,
        cam: readCameraChoice,
        wantAudio: () => audioOn,
        wantCam: () => camOn,
        onCameraSupport: (supported) => {
            // A Pi that cannot take a camera cannot be sent one: a camera left on from an earlier session is off now.
            if (!supported && camOn) {
                camOn = false;
                patchAudio({ camOn: false, camLabel: CAMERA_LABELS.off, camWarn: false });
            }
            patchAudio({ camSupport: supported ? "yes" : "no" });
        },
        onCameraSent: (sent) => patchAudio({ camSent: sent }),
        onCameraEnded: () => void cameraEnded(),
    });

    // Unmute without losing the picture: if the browser blocks it (no gesture), keep the muted
    // picture playing and unmute on the next interaction instead.
    const tryUnmute = (): void => {
        video.muted = false;
        void video.play().then(
            () => patchAudio({ blocked: false }),
            () => {
                video.muted = true;
                void video.play().catch(() => {});
                armGestureUnmute();
            },
        );
    };
    function armGestureUnmute(): void {
        // Said once, on the way into waiting: a refused attempt that re-arms must not repeat it.
        const alreadyWaiting = store.getState().audio.blocked;
        patchAudio({ blocked: true });
        if (!alreadyWaiting) session.notices.notify({ text: "Tap anywhere to turn on sound" });
        if (gestureArmed) return;
        gestureArmed = true;
        // A touch is a gesture Safari accepts when it is released, not when it lands (gesture-unmute.ts, K38).
        cancelGestureUnmute = onNextActivation(document, (event) => {
            gestureArmed = false;
            cancelGestureUnmute = null;
            // A tap on the speaker button is that button's own press: its click turns the sound on (toggleAudio),
            // and unmuting here first would let the click turn it straight back off.
            if (event.target instanceof Element && event.target.closest('[data-tb="audio"], [data-setting="audio"]')) return;
            if (audioOn && store.getState().webrtc && video.muted) tryUnmute();
        });
    }

    const applySink = (): void => {
        const id = readDeviceChoice(OUT_DEVICE_KEY).id;
        const sinkable = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
        if (id && typeof sinkable.setSinkId === "function") void sinkable.setSinkId(id).catch(() => {});
    };

    const avSummary = (): string => {
        // Only a WebRTC session carries audio at all; audioOn is a desired state that survives a drop.
        if (!store.getState().webrtc) return "";
        return [audioOn ? "\u{1F50A}" : "", micOn ? "\u{1F399}" : "", camOn ? "\u{1F4F7}" : ""].filter(Boolean).join(" ");
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

    const alerts = createScreenAlerts({ clock, attention: attentionSink(), watching: () => prefs.watching });
    const dom = createVideoDom({
        onLuma: (lum) => alerts.sample(lum),
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

    const camFailure = (error: unknown): void => {
        const kind = classifyCameraError(error, !!readDeviceChoice(CAM_DEVICE_KEY).id);
        // Same split as the microphone: a refused prompt is "Denied", a pinned camera that was unplugged is named.
        const label =
            kind === "gone"
                ? CAMERA_LABELS.gone
                : kind === "none"
                  ? CAMERA_LABELS.none
                  : kind === "denied"
                    ? CAMERA_LABELS.denied
                    : kind === "busy"
                      ? CAMERA_LABELS.busy
                      : CAMERA_LABELS.stopped;
        patchAudio({ camLabel: label, camWarn: true });
        const sentence = CAMERA_WARNINGS[label];
        // A press that fails must be seen to fail: the pip is on a button, and on a phone nobody hovers its title.
        if (sentence) session.notices.notify({ text: sentence, error: true });
        // The list says why too ("denied" lists no camera at all), and it is what the control reads before the next press.
        void reconcileCamera();
    };

    /** The camera permission as the browser reports it, or null where it does not say ("camera" is not in every browser's Permissions API). */
    const cameraPermission = async (): Promise<PermissionState | null> => {
        try {
            return (await navigator.permissions?.query({ name: "camera" as PermissionName }))?.state ?? null;
        } catch {
            return null;
        }
    };

    /** Whether the camera the console would use is there now. A blocked permission is its own answer: Chromium lists no camera then, and others list names they will not open. */
    const cameraPresence = async (): Promise<"present" | "gone" | "none" | "denied" | "unknown"> => {
        try {
            const cameras = collectDevices(await navigator.mediaDevices.enumerateDevices(), "videoinput");
            const pinned = readDeviceChoice(CAM_DEVICE_KEY).id;
            if ((await cameraPermission()) === "denied") return "denied";
            if (cameras.length === 0) return "none";
            return pinned && !cameras.some((device) => device.id === pinned) ? "gone" : "present";
        } catch {
            return "unknown";
        }
    };

    /** The camera is off and says why: the pip, the warning and one notice. */
    const stopCamera = (label: string): void => {
        if (!camOn) return;
        camOn = false;
        janus.current()?.setCam(false);
        patchAudio({ camOn: false, camLabel: label, camWarn: true, camSent: null });
        const sentence = CAMERA_WARNINGS[label];
        if (sentence) session.notices.notify({ text: sentence, error: true });
        showResolution(true);
    };

    const reasonFor = (presence: "present" | "gone" | "none" | "denied" | "unknown"): string =>
        presence === "gone" ? CAMERA_LABELS.gone : presence === "none" ? CAMERA_LABELS.none : presence === "denied" ? CAMERA_LABELS.denied : CAMERA_LABELS.stopped;

    /** The camera's track ended under a live session: the camera was unplugged, or its permission was withdrawn. */
    const cameraEnded = async (): Promise<void> => {
        if (!camOn) return;
        const denied = (await cameraPermission()) === "denied";
        stopCamera(reasonFor(denied ? "denied" : await cameraPresence()));
    };

    /**
     * A camera came or went (devicechange), the choice changed, or the permission did. A camera that is on and has vanished is
     * turned off with the reason; a "gone", "no camera" or "denied" warning that no longer holds is cleared, because nothing
     * else would, and said once.
     */
    const reconcileCamera = async (): Promise<void> => {
        const presence = await cameraPresence();
        if (presence !== "unknown") patchAudio({ camDevices: presence === "denied" ? "denied" : presence === "none" ? "none" : "some" });
        const { camOn: on, camLabel } = store.getState().audio;
        if (on && presence !== "present" && presence !== "unknown") {
            stopCamera(reasonFor(presence));
        } else if (!on && presence === "present" && (camLabel === CAMERA_LABELS.gone || camLabel === CAMERA_LABELS.none || camLabel === CAMERA_LABELS.denied)) {
            patchAudio({ camLabel: CAMERA_LABELS.off, camWarn: false });
            session.notices.notify({ text: "The camera is available again. Turn it on to send it." });
        }
    };
    const mediaDevices: MediaDevices | undefined = navigator.mediaDevices;
    const onDeviceChange = (): void => void reconcileCamera();
    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    // Allowing or blocking the camera in the browser's own settings changes what the list holds, and raises no devicechange.
    let permissionWatch: PermissionStatus | null = null;
    navigator.permissions?.query({ name: "camera" as PermissionName }).then(
        (status) => {
            permissionWatch = status;
            status.addEventListener("change", onDeviceChange);
        },
        () => {},
    );
    void reconcileCamera();

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
            if (pointerBlocked(prefs) !== pointerBlocked(before)) envPatch.modalOpen = pointerBlocked(prefs);
            if (prefs.windowFocused !== before.windowFocused) envPatch.windowFocused = prefs.windowFocused;
            if (Object.keys(envPatch).length > 0) sendEnv(envPatch);
            // Sampling goes on while the document is hidden only when somebody is watching.
            if (prefs.watching !== before.watching) driver.send({ type: "need", collapsed: false, watching: prefs.watching });
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
            // Sound is wanted but still waiting for a tap: this press is the tap, so it turns sound on, not off.
            if (audioOn && store.getState().webrtc && video.muted) {
                cancelGestureUnmute?.();
                cancelGestureUnmute = null;
                gestureArmed = false;
                tryUnmute();
                return;
            }
            audioOn = !audioOn;
            video.muted = !audioOn;
            if (audioOn) void video.play().catch(() => {});
            janus.current()?.setAudio(audioOn);
            patchAudio({ audioOn, blocked: false });
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
        toggleCam() {
            if (camOn) {
                camOn = false;
                janus.current()?.setCam(false);
                patchAudio({ camOn: false, camLabel: CAMERA_LABELS.off, camWarn: false, camSent: null });
                showResolution(true);
                return;
            }
            // The camera is always drawn, but a press the Pi or the picture cannot honour says so and sends nothing:
            // video to a Pi that cannot take it would go nowhere, and the `features` reply stays the gate for sending.
            const { webrtc, audio } = store.getState();
            const blocked = cameraBlock({ browser: cameraOpenable(), webrtc, support: audio.camSupport, devices: audio.camDevices });
            if (blocked) {
                session.notices.notify({ text: blocked.reason, error: true });
                return;
            }
            const stream = janus.current();
            if (!stream) return;
            patchAudio({ camLabel: CAMERA_LABELS.working, camWarn: false });
            // Pre-flight the permission prompt so a refusal can be named, with the constraints the real capture uses:
            // it fails in exactly the cases the capture would. The real capture is opened by the session, so these
            // tracks are not kept.
            navigator.mediaDevices
                .getUserMedia({ video: cameraConstraints(readCameraChoice()) })
                .then((granted) => {
                    for (const track of granted.getTracks()) track.stop();
                    camOn = true;
                    stream.setCam(true);
                    patchAudio({ camOn: true, camLabel: CAMERA_LABELS.on, camWarn: false });
                    // A permission that was blocked and has been allowed: the list has its cameras back.
                    void reconcileCamera();
                    showResolution(true);
                })
                .catch(camFailure);
        },
        devicesChanged() {
            janus.current()?.micDeviceChanged();
            janus.current()?.camChanged();
            void reconcileCamera();
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
            mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
            permissionWatch?.removeEventListener("change", onDeviceChange);
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
            offCursor();
            cancelResHide?.();
            cancelResEmpty?.();
            cancelReenable?.();
            cancelGestureUnmute?.();
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
