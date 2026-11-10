/**
 * The camera, as one idea: what can be asked of it (the presets), what the console remembers per camera,
 * how the browser is asked for it, and why the control says what it says. The toolbar, the dock, the sheet and
 * the menu all read `cameraView`, so they agree on when the camera is off, why, and in which words (K53).
 */

import { useMemo } from "react";
import {
    CAM_DEVICE_KEY,
    CAM_PREFS_KEY,
    readCameraPrefs,
    readDeviceChoice,
    readString,
    useStoredValue,
    type CameraPrefs,
    type DeviceChoice,
} from "../settings/local-prefs";

export interface CameraPreset {
    readonly id: string;
    readonly label: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
}

/**
 * What the Pi's USB camera takes: 1280x720 at most (the PiKVM handbook, "Web Camera on PiKVM V4 and V3"; 640x480 in
 * its safe mode). Its `features` reply is only a yes or no for `cam`, so the limit is a fact of the product, not
 * something read from the reply, and nothing above it is offered: it would only cost upload bandwidth and be scaled
 * down or refused at the other end.
 */
export const PI_CAMERA_LIMIT = { width: 1280, height: 720 } as const;

/** The sizes offered (16:9, none above the limit) and the frame rates; a preset is one of each. */
export const CAMERA_SIZES: ReadonlyArray<{ readonly label: string; readonly width: number; readonly height: number }> = [
    { label: "360p", width: 640, height: 360 },
    { label: "480p", width: 854, height: 480 },
    { label: "720p", width: 1280, height: 720 },
];
export const CAMERA_RATES: ReadonlyArray<number> = [30, 15];

export const CAMERA_PRESETS: ReadonlyArray<CameraPreset> = CAMERA_SIZES.flatMap((size) =>
    CAMERA_RATES.map((fps) => ({ id: `${size.height}p${fps}`, label: size.label, width: size.width, height: size.height, fps })),
);

export const DEFAULT_CAMERA_PRESET_ID = "720p30";

export const CAMERA_DOCS_URL = "https://docs.pikvm.org/camera/";
export const CAMERA_README_URL = "https://github.com/kierandrewett/pikvm-desktop-agentic#camera";

/** "720p, 30 fps": the size class and the frame rate of a preset, as the menu and the pip say them. */
export const presetText = (preset: CameraPreset): string => `${preset.label}, ${preset.fps} fps`;

/** A preset id that is not one (a stale or hand-edited value) is the default, never an error. */
export function resolvePreset(id: string): CameraPreset {
    const found = CAMERA_PRESETS.find((preset) => preset.id === id);
    return found ?? (CAMERA_PRESETS.find((preset) => preset.id === DEFAULT_CAMERA_PRESET_ID) as CameraPreset);
}

export interface CameraChoice {
    readonly deviceId: string;
    readonly preset: CameraPreset;
}

/** The camera and quality the console will use right now, read from this browser's storage. */
export function readCameraChoice(): CameraChoice {
    const deviceId = readDeviceChoice(CAM_DEVICE_KEY).id;
    return { deviceId, preset: resolvePreset(readCameraPrefs(deviceId).preset) };
}

/** Two choices with the same key need the same capture; a different key restarts a live camera. */
export const cameraKey = (choice: CameraChoice): string => `${choice.deviceId}|${choice.preset.id}`;

/**
 * The constraints the camera is opened with, by the preview and by the session alike. The size is `ideal`, so a camera
 * that cannot do it gives its nearest mode and the effective size is what is reported; the device is `exact`, so an
 * unplugged camera fails and is named instead of being replaced by whichever the browser likes now.
 */
export function cameraConstraints(choice: CameraChoice): MediaTrackConstraints {
    return {
        ...(choice.deviceId ? { deviceId: { exact: choice.deviceId } } : {}),
        width: { ideal: choice.preset.width },
        height: { ideal: choice.preset.height },
        frameRate: { ideal: choice.preset.fps },
    };
}

/** The settings of a live camera track, which is what the browser really gave, not what was asked. */
export interface CameraSent {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
}

export function sentFrom(settings: MediaTrackSettings): CameraSent | null {
    if (!settings.width || !settings.height) return null;
    return { width: settings.width, height: settings.height, fps: Math.round(settings.frameRate ?? 0) };
}

export const sentText = (sent: CameraSent): string => `${sent.width} \u00d7 ${sent.height}${sent.fps > 0 ? ` \u00b7 ${sent.fps} fps` : ""}`;

/** What the Pi said about its camera: not asked yet (no WebRTC session has reported), or the `cam` feature's answer. */
export type CameraSupport = "unknown" | "yes" | "no";

/**
 * What the browser's device list says. "none": no camera is listed. "denied": none is listed because the camera's
 * permission is blocked (Chromium lists no camera at all then), which is not the same fault and is fixed somewhere else.
 */
export type CameraDevices = "unknown" | "some" | "none" | "denied";

export type CameraErrorKind = "denied" | "busy" | "gone" | "none" | "other";

/**
 * What a failed getUserMedia means for a camera. A refused prompt is "denied"; a camera another app holds is "busy"; a
 * camera that is missing is "gone" when one was chosen by name (it was unplugged) and "none" when the browser simply
 * has no camera. Sending someone to the browser's permissions to fix a camera they pulled out would be wrong.
 */
export function classifyCameraError(error: unknown, pinned: boolean): CameraErrorKind {
    const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
    if (name === "OverconstrainedError" || name === "NotFoundError" || name === "DevicesNotFoundError") return pinned ? "gone" : "none";
    return "other";
}

/** The pips and notes a camera can carry. The first group is the controller's own; the second is why it cannot start. */
export const CAMERA_LABELS = {
    on: "On",
    off: "Off",
    working: "\u2026",
    denied: "Denied",
    none: "No camera",
    gone: "Camera gone",
    stopped: "Stopped",
    noPi: "Unavailable on this PiKVM",
    needsWebrtc: "Needs WebRTC",
    needsHttps: "Needs HTTPS",
    busy: "In use",
} as const;

export const NO_PI_CAMERA_NOTE =
    "This PiKVM does not offer a USB camera. It needs a V3 or V4 with the ucamera package and the OTG camera enabled.";

/** One sentence per warning, for titles, notices and the menu's note. */
export const CAMERA_WARNINGS: Readonly<Record<string, string>> = {
    [CAMERA_LABELS.denied]: "Camera access was refused. Allow it for this site in your browser's settings, then turn the camera on again.",
    [CAMERA_LABELS.none]: "This browser found no camera. Plug one in; it is listed as soon as it appears.",
    [CAMERA_LABELS.gone]: "The camera you chose is not connected. Plug it back in, or pick another in the camera menu.",
    [CAMERA_LABELS.busy]: "Another app is using the camera, so this browser cannot open it. Close that app, then try again.",
    [CAMERA_LABELS.stopped]: "The browser stopped the camera, so it is off. Turn it on to send it again.",
};

export interface CameraFacts {
    /** The browser can open a camera at all: a secure page with `mediaDevices.getUserMedia`. */
    readonly browser: boolean;
    readonly webrtc: boolean;
    /** The browser's device list, as last read. */
    readonly devices: CameraDevices;
    readonly support: CameraSupport;
    readonly on: boolean;
    readonly label: string;
    readonly warn: boolean;
}

export interface CameraView {
    /** Why the camera cannot be turned on right now, or null. A camera that is already on can always be turned off. */
    readonly blocked: { readonly label: string; readonly reason: string } | null;
    /** What the pip says. */
    readonly label: string;
    /** The button's title: the state, and the way out of it. */
    readonly title: string;
    readonly on: boolean;
    readonly warn: boolean;
}

/** Whether the browser can open a camera: `mediaDevices` is absent on a page that is not secure (plain http on a phone). */
export const cameraOpenable = (): boolean => typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

export function cameraBlock(facts: Pick<CameraFacts, "browser" | "webrtc" | "support" | "devices">): CameraView["blocked"] {
    // Order matters: the Pi answer is the more lasting fact, so it outranks the picture being between sessions.
    if (!facts.browser) {
        return { label: CAMERA_LABELS.needsHttps, reason: "Camera access needs a secure page. Open the console over HTTPS." };
    }
    if (facts.support === "no") return { label: CAMERA_LABELS.noPi, reason: NO_PI_CAMERA_NOTE };
    if (facts.devices === "none") return { label: CAMERA_LABELS.none, reason: CAMERA_WARNINGS[CAMERA_LABELS.none] ?? "" };
    // A session that has answered once (`support` is known) is only between sessions when the picture is not WebRTC: every change of
    // the camera restarts the session, and the button must not flicker "Needs WebRTC" through that second. Never answered means
    // MJPEG, or a Pi still being asked.
    if (!facts.webrtc && facts.support !== "yes") {
        return {
            label: CAMERA_LABELS.needsWebrtc,
            reason: "The camera travels with the WebRTC picture. Switch the video mode to WebRTC, or wait for it to connect.",
        };
    }
    return null;
}

export function cameraView(facts: CameraFacts): CameraView {
    const blocked = facts.on ? null : cameraBlock(facts);
    if (blocked) return { blocked, label: blocked.label, title: `Camera: ${blocked.reason}`, on: false, warn: false };
    // A blocked permission is a warning, not a block: a press asks again, which is how a fixed setting is noticed.
    const denied = !facts.on && facts.devices === "denied";
    const label = denied ? CAMERA_LABELS.denied : facts.label;
    const warn = denied || facts.warn;
    const note = warn ? CAMERA_WARNINGS[label] : undefined;
    const title = facts.on ? "Camera is on. Press to turn it off." : note ? `Camera: ${label}. ${note}` : "Turn the camera on";
    return { blocked: null, label, title, on: facts.on, warn };
}

export interface CameraSelection {
    /** The camera chosen by name, with the label it had (so an unplugged one can be named); empty id is the system default. */
    readonly device: DeviceChoice;
    readonly prefs: CameraPrefs;
    readonly choice: CameraChoice;
}

/** The camera chosen now, its quality and its mirror choice, live: it changes when any of them is picked anywhere. */
export function useCameraSelection(): CameraSelection {
    const [rawDevice] = useStoredValue(CAM_DEVICE_KEY, () => readString(CAM_DEVICE_KEY));
    const [rawPrefs] = useStoredValue(CAM_PREFS_KEY, () => readString(CAM_PREFS_KEY));
    // The raw strings are the dependencies: the stored value changed, so it is read again.
    return useMemo(() => {
        const device = readDeviceChoice(CAM_DEVICE_KEY);
        const prefs = readCameraPrefs(device.id);
        return { device, prefs, choice: { deviceId: device.id, preset: resolvePreset(prefs.preset) } };
    }, [rawDevice, rawPrefs]);
}
