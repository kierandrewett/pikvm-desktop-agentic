/**
 * Audio devices: the microphone and the audio output, each pinned to a NAMED device and
 * remembered, because the browser's own default is whatever the OS last decided, which moves when
 * a headset is plugged in, a call app grabs the line, or Bluetooth reconnects. An empty choice
 * means "follow the system default", chosen rather than inherited.
 *
 * A pinned device that has gone is NAMED as gone, never quietly replaced by another (the select
 * keeps the stored choice as an option, or it would report the first option instead).
 */

import { useState } from "react";
import type { DialogProps } from "../dialog-seam";
import { emitAudioDevicesChanged } from "../audio-devices-event";
import { labelsHidden, speakerSelectionSupported, useAudioDevices, audioDevicesSupported, type AudioDevice } from "../../settings/pages/audio-devices";
import { CAM_DEVICE_KEY, CAM_PREFS_KEY, MIC_DEVICE_KEY, OUT_DEVICE_KEY, readDeviceChoice, writeCameraPrefs, writeDeviceChoice, type DeviceChoice } from "../../settings/local-prefs";
import { CAMERA_PRESETS, presetText, useCameraSelection } from "../camera";
import { Btn, DialogShell, Note } from "./shell";

export function goneSentence(kind: string, choice: DeviceChoice): string {
    return `The ${kind} you chose${choice.label ? ` (${choice.label})` : ""} is not connected.`;
}

interface PickerProps {
    readonly id: string;
    readonly label: string;
    readonly storageKey: string;
    readonly devices: ReadonlyArray<AudioDevice>;
    readonly choice: DeviceChoice;
    readonly disabled: boolean;
    readonly onChoose: (choice: DeviceChoice) => void;
}

function DevicePicker({ id, label, devices, choice, disabled, onChoose, storageKey }: PickerProps) {
    const known = !choice.id || devices.some((d) => d.id === choice.id);
    return (
        <div className="dlg-row stack">
            <label className="dlg-label" htmlFor={id} style={{ minWidth: 92 }}>
                {label}
            </label>
            <select
                id={id}
                className="dlg-select dlg-grow"
                value={choice.id}
                disabled={disabled}
                data-storage-key={storageKey}
                onChange={(e) => {
                    const picked = devices.find((d) => d.id === e.target.value);
                    onChoose(e.target.value ? { id: e.target.value, label: picked?.label || choice.label } : { id: "", label: "" });
                }}
            >
                <option value="">Follow the system default</option>
                {known ? null : <option value={choice.id}>{`${choice.label || "The device you chose"} (not connected)`}</option>}
                {devices.map((d, i) => (
                    <option key={d.id} value={d.id}>
                        {d.label || `${label} ${i + 1}`}
                    </option>
                ))}
            </select>
        </div>
    );
}

export function AudioDevicesDialog({ onClose }: DialogProps) {
    const { inputs, outputs, cameras, loaded, error, allowAccess } = useAudioDevices();
    const [mic, setMic] = useState<DeviceChoice>(() => readDeviceChoice(MIC_DEVICE_KEY));
    const [out, setOut] = useState<DeviceChoice>(() => readDeviceChoice(OUT_DEVICE_KEY));
    const [cam, setCam] = useState<DeviceChoice>(() => readDeviceChoice(CAM_DEVICE_KEY));
    const haveApi = audioDevicesSupported();
    const camSelection = useCameraSelection();
    const sink = speakerSelectionSupported();

    const choose = (key: string, set: (c: DeviceChoice) => void) => (choice: DeviceChoice) => {
        writeDeviceChoice(key, choice);
        set(choice);
        // A running stream has to re-pin the microphone, the camera and the speaker.
        emitAudioDevicesChanged();
    };

    // "Not in the list" is only a claim worth making once there is a list.
    const micGone = loaded && !!mic.id && !inputs.some((d) => d.id === mic.id);
    const outGone = loaded && !!out.id && !outputs.some((d) => d.id === out.id);
    const camGone = loaded && !!cam.id && !cameras.some((d) => d.id === cam.id);
    const wrong: string[] = [];
    if (micGone) wrong.push(goneSentence("microphone", mic));
    if (outGone) wrong.push(goneSentence("audio output", out));
    if (camGone) wrong.push(goneSentence("camera", cam));

    const hidden = labelsHidden(inputs) || labelsHidden(outputs);
    // What is WRONG goes in the live region; what is merely true goes in the static one.
    const notes: string[] = [];
    if (!haveApi) notes.push("This browser will not list audio devices, so both follow the system default.");
    else if (!sink) notes.push("This browser cannot choose where audio is played, so the output follows the system default.");
    else if (hidden) notes.push("Device names appear once the microphone has been allowed.");
    else if (wrong.length === 0) {
        notes.push(
            "Both choices are remembered. A headset plugged in, or a call app taking the line, no longer moves the microphone sent to the target.",
        );
    }

    return (
        <DialogShell
            title="Audio devices"
            onClose={onClose}
            testId="audio-devices-dialog"
            actions={
                <Btn variant="primary" onClick={onClose}>
                    Done
                </Btn>
            }
        >
            <DevicePicker
                id="ad-mic"
                label="Microphone"
                storageKey={MIC_DEVICE_KEY}
                devices={inputs}
                choice={mic}
                disabled={!haveApi}
                onChoose={choose(MIC_DEVICE_KEY, setMic)}
            />
            <DevicePicker
                id="ad-out"
                label="Audio output"
                storageKey={OUT_DEVICE_KEY}
                devices={outputs}
                choice={out}
                disabled={!haveApi || !sink}
                onChoose={choose(OUT_DEVICE_KEY, setOut)}
            />
            <DevicePicker
                id="ad-cam"
                label="Camera"
                storageKey={CAM_DEVICE_KEY}
                devices={cameras}
                choice={cam}
                disabled={!haveApi}
                onChoose={choose(CAM_DEVICE_KEY, setCam)}
            />
            <div className="dlg-row stack">
                <label className="dlg-label" htmlFor="ad-cam-quality" style={{ minWidth: 92 }}>
                    Camera quality
                </label>
                <select
                    id="ad-cam-quality"
                    className="dlg-select dlg-grow"
                    value={camSelection.choice.preset.id}
                    data-storage-key={CAM_PREFS_KEY}
                    onChange={(e) => {
                        writeCameraPrefs(camSelection.device.id, { preset: e.target.value });
                        emitAudioDevicesChanged();
                    }}
                >
                    {CAMERA_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                            {`${presetText(preset)} (${preset.width} \u00d7 ${preset.height})`}
                        </option>
                    ))}
                </select>
            </div>
            <p className={`dlg-note${wrong.length > 0 ? " is-warn" : ""}`} role="status" aria-live="polite">
                {wrong.join(" ")}
            </p>
            {notes.length > 0 ? <Note>{notes.join(" ")}</Note> : null}
            {hidden && haveApi ? (
                <div className="dlg-inline-actions">
                    <Btn onClick={() => void allowAccess()}>Allow microphone access</Btn>
                </div>
            ) : null}
            {error ? (
                <p className="dlg-note is-warn" role="alert">
                    {error}
                </p>
            ) : null}
        </DialogShell>
    );
}
