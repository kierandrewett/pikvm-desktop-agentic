/**
 * What the camera menu holds, and what the phone sheet unfolds under its camera row: a live self-view, the state in a
 * sentence, the cameras, the quality presets and the mirror switch. It is the camera's counterpart of the speaker and
 * microphone menus, with a preview where theirs have a level.
 *
 * It is mounted only while it is on screen, and its preview exists only while it is mounted (camera-preview.ts), so
 * closing the menu lets the camera go. It sends nothing itself: choosing a camera or a quality writes the choice and
 * tells the session (emitAudioDevicesChanged), which restarts a live camera if the choice changed.
 */

import { Warning } from "@pikvm/icons";
import { useEffect, useRef } from "react";
import { audioDevicesSupported, useAudioDevices } from "../settings/pages/audio-devices";
import { CAM_DEVICE_KEY, writeCameraPrefs, writeDeviceChoice } from "../settings/local-prefs";
import { emitAudioDevicesChanged } from "./audio-devices-event";
import {
    CAMERA_DOCS_URL,
    CAMERA_RATES,
    CAMERA_SIZES,
    CAMERA_README_URL,
    CAMERA_WARNINGS,
    DEFAULT_CAMERA_PRESET_ID,
    PI_CAMERA_LIMIT,
    sentText,
    useCameraSelection,
    type CameraView,
} from "./camera";
import { useCameraPreview, type CameraPresence, type PreviewPhase } from "./camera-preview";
import type { AudioState } from "./picture-controller";
import "./camera.css";

export type CameraPanelVariant = "menu" | "inline";

interface StageMessage {
    readonly text: string;
    /** Whether asking again can help. */
    readonly retry: boolean;
}

const STAGE_MESSAGES: Readonly<Partial<Record<PreviewPhase, StageMessage>>> = {
    pending: { text: "Looking for cameras\u2026", retry: false },
    starting: { text: "Starting the camera\u2026", retry: false },
    denied: { text: "Camera access was refused.", retry: true },
    busy: { text: "Another app is using the camera.", retry: true },
    gone: { text: "The camera you chose is not connected.", retry: false },
    none: { text: "This browser found no camera.", retry: false },
    stopped: { text: "The camera stopped.", retry: true },
    unsupported: { text: "This page cannot open a camera.", retry: false },
    error: { text: "The camera could not be opened.", retry: true },
};

export interface CameraPanelProps {
    readonly view: CameraView;
    readonly audio: AudioState;
    readonly variant: CameraPanelVariant;
}

/** The sentence under the preview: the state of the camera that is going to the target, not of the preview. */
function statusSentence(view: CameraView, audio: AudioState): { readonly text: string; readonly tone: "ok" | "warn" | "plain" } {
    if (view.blocked) return { text: view.blocked.reason, tone: "plain" };
    const warning = audio.camWarn ? CAMERA_WARNINGS[audio.camLabel] : undefined;
    if (warning) return { text: warning, tone: "warn" };
    if (!audio.camOn) return { text: "Off. Press the camera button to send this camera to the target.", tone: "plain" };
    if (!audio.camSent) return { text: "On. Opening the camera for the target\u2026", tone: "plain" };
    return {
        text: `On. Ready to send ${sentText(audio.camSent)}. The target starts the stream when an app on it opens the camera.`,
        tone: "ok",
    };
}

export function CameraPanel({ view, audio, variant }: CameraPanelProps) {
    const { cameras, loaded, error, refresh } = useAudioDevices();
    const { device, prefs, choice } = useCameraSelection();
    const listable = audioDevicesSupported();

    const known = !device.id || cameras.some((camera) => camera.id === device.id);
    let presence: CameraPresence = "ok";
    // A blocked permission lists no camera at all: ask anyway, so the preview says "refused" and not "no camera".
    if (listable && !error && audio.camDevices !== "denied") {
        if (!loaded) presence = "pending";
        else if (cameras.length === 0) presence = "none";
        else if (!known) presence = "gone";
    }
    const preview = useCameraPreview(choice, presence, () => void refresh());
    // The browser's own camera state moved (a permission allowed or blocked, a camera came or went): read the list again.
    useEffect(() => {
        void refresh();
    }, [audio.camDevices, refresh]);

    const video = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        element.srcObject = preview.stream;
        if (preview.stream) void element.play().catch(() => {});
    }, [preview.stream]);

    const pick = (id: string, label: string): void => {
        writeDeviceChoice(CAM_DEVICE_KEY, { id, label });
        emitAudioDevicesChanged();
    };
    const setPreset = (preset: string): void => {
        writeCameraPrefs(device.id, { preset });
        emitAudioDevicesChanged();
    };

    const stage = STAGE_MESSAGES[preview.phase];
    const status = statusSentence(view, audio);
    const asked = choice.preset;
    const settings = preview.settings;
    const differs = settings !== null && (settings.width !== asked.width || settings.height !== asked.height);

    return (
        <div className={`kvm-cam kvm-cam-${variant}`} data-testid="camera-panel" data-phase={preview.phase}>
            <div className="kvm-cam-stage">
                <video
                    ref={video}
                    className={`kvm-cam-video${prefs.mirror ? " is-mirrored" : ""}`}
                    data-testid="camera-preview"
                    aria-label="Camera preview"
                    autoPlay
                    muted
                    playsInline
                    hidden={preview.phase !== "live"}
                />
                {stage ? (
                    <div className="kvm-cam-msg" role="status" aria-live="polite" data-testid="camera-preview-message">
                        {preview.phase === "starting" || preview.phase === "pending" ? <span className="kvm-cam-spin" aria-hidden="true" /> : <Warning />}
                        <span>{stage.text}</span>
                        {stage.retry ? (
                            <button type="button" className="kvm-cam-retry" onClick={preview.retry}>
                                Try again
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {settings ? (
                    <span className="kvm-cam-chip" data-testid="camera-preview-size">
                        {sentText(settings)}
                    </span>
                ) : null}
            </div>

            <p className={`kvm-cam-status is-${status.tone}`} role="status" aria-live="polite" data-testid="camera-status">
                {status.text}
                {view.blocked && audio.camSupport === "no" ? (
                    <>
                        {" "}
                        <a href={CAMERA_DOCS_URL} target="_blank" rel="noreferrer noopener">
                            PiKVM handbook
                        </a>
                        {" \u00b7 "}
                        <a href={CAMERA_README_URL} target="_blank" rel="noreferrer noopener">
                            README
                        </a>
                    </>
                ) : null}
            </p>
            {differs && settings ? (
                <p className="kvm-cam-status is-plain" data-testid="camera-differs">
                    {`Asked for ${asked.width} \u00d7 ${asked.height}; this camera opened at ${settings.width} \u00d7 ${settings.height}.`}
                </p>
            ) : null}

            <div className="kvm-cam-label" id="kvm-cam-devices">
                Camera
            </div>
            <div className="kvm-cam-list" role="group" aria-labelledby="kvm-cam-devices">
                <button type="button" className="kvm-item kvm-cam-opt" aria-pressed={!device.id} onClick={() => pick("", "")}>
                    Follow the system default
                </button>
                {cameras.map((camera, index) => (
                    <button
                        key={camera.id}
                        type="button"
                        className="kvm-item kvm-cam-opt"
                        aria-pressed={camera.id === device.id}
                        data-device={camera.id}
                        onClick={() => pick(camera.id, camera.label)}
                    >
                        {camera.label || `Camera ${index + 1}`}
                    </button>
                ))}
                {!known ? (
                    <button type="button" className="kvm-item kvm-cam-opt is-gone" aria-pressed="true" disabled>
                        {`${device.label || "The camera you chose"} (not connected)`}
                    </button>
                ) : null}
            </div>

            <div className="kvm-cam-label" id="kvm-cam-quality">
                Quality
            </div>
            <div className="kvm-cam-seg" role="group" aria-labelledby="kvm-cam-quality">
                {CAMERA_SIZES.map((size) => (
                    <button
                        key={size.height}
                        type="button"
                        className="kvm-cam-segment"
                        aria-pressed={size.height === asked.height}
                        data-size={size.height}
                        onClick={() => setPreset(`${size.height}p${asked.fps}`)}
                    >
                        {size.label}
                    </button>
                ))}
            </div>
            <div className="kvm-cam-label" id="kvm-cam-rate">
                Frame rate
            </div>
            <div className="kvm-cam-seg" role="group" aria-labelledby="kvm-cam-rate">
                {CAMERA_RATES.map((fps) => (
                    <button
                        key={fps}
                        type="button"
                        className="kvm-cam-segment"
                        aria-pressed={fps === asked.fps}
                        data-fps={fps}
                        onClick={() => setPreset(`${asked.height}p${fps}`)}
                    >
                        {`${fps} fps`}
                    </button>
                ))}
            </div>
            <p className="kvm-cam-fine" data-testid="camera-quality-note">
                {`Asks the camera for ${asked.width} \u00d7 ${asked.height} at ${asked.fps} fps${asked.id === DEFAULT_CAMERA_PRESET_ID ? " (the default)" : ""}. The PiKVM camera takes ${PI_CAMERA_LIMIT.width} \u00d7 ${PI_CAMERA_LIMIT.height} at most, so nothing above it is offered. Remembered for this camera.`}
            </p>

            <button
                type="button"
                className="kvm-item toggle kvm-cam-mirror"
                role="switch"
                aria-checked={prefs.mirror}
                data-testid="camera-mirror"
                onClick={() => writeCameraPrefs(device.id, { mirror: !prefs.mirror })}
            >
                <span>Mirror the preview</span>
                <span className="kvm-pip">{prefs.mirror ? "On" : "Off"}</span>
            </button>
            <p className="kvm-cam-fine">The target always sees the true picture, not the mirrored one.</p>
        </div>
    );
}
