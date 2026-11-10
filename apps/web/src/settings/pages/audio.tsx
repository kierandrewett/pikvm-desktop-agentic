import { useState } from "react";
import { Button, Select, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import {
    CAM_DEVICE_KEY,
    type DeviceChoice,
    MIC_DEVICE_KEY,
    OUT_DEVICE_KEY,
    readDeviceChoice,
    writeCameraPrefs,
    writeDeviceChoice,
} from "../local-prefs";
import { CAMERA_PRESETS, presetText, useCameraSelection } from "../../kvm/camera";
import {
    type AudioDevice,
    labelsHidden,
    speakerSelectionSupported,
    useAudioDevices,
} from "./audio-devices";

interface DeviceSelectProps {
    label: string;
    storageKey: string;
    devices: ReadonlyArray<AudioDevice>;
}

function DeviceSelect({ label, storageKey, devices }: DeviceSelectProps) {
    const [choice, setChoice] = useState<DeviceChoice>(() => readDeviceChoice(storageKey));
    const known = devices.some((device) => device.id === choice.id);

    const options = [
        { value: "", label: "Follow the system default" },
        // Pinned to a device that is not here: say so rather than quietly showing another.
        ...(choice.id && !known ? [{ value: choice.id, label: `${choice.label || "Chosen device"} (not connected)` }] : []),
        ...devices.map((device, index) => ({ value: device.id, label: device.label || `${label} ${index + 1}` })),
    ];

    return (
        <Select
            label={label}
            value={choice.id}
            options={options}
            onChange={(id) => {
                const picked = devices.find((device) => device.id === id);
                const next = { id, label: picked?.label || choice.label };
                const stored = id ? next : { id: "", label: "" };
                writeDeviceChoice(storageKey, stored);
                setChoice(stored);
            }}
        />
    );
}

export function AudioPage() {
    const { inputs, outputs, cameras, loaded, error, allowAccess } = useAudioDevices();
    const hidden = labelsHidden(inputs) || labelsHidden(outputs);
    const camera = useCameraSelection();

    return (
        <SettingsPage title="Audio" description="Microphone, speaker and camera.">
            <SettingsSection
                title="Devices"
                description="For the target's sound, your microphone and your camera on the KVM screen. An unplugged device you chose is marked, not replaced."
            >
                <SettingsCard>
                    {loaded ? (
                        <SettingRow
                            id="microphone"
                            label="Microphone"
                            control={<DeviceSelect label="Microphone" storageKey={MIC_DEVICE_KEY} devices={inputs} />}
                        />
                    ) : null}
                    {loaded && speakerSelectionSupported() ? (
                        <SettingRow
                            id="speaker"
                            label="Speaker"
                            control={<DeviceSelect label="Speaker" storageKey={OUT_DEVICE_KEY} devices={outputs} />}
                        />
                    ) : null}
                    {loaded && !speakerSelectionSupported() ? (
                        <SettingRow label="Speaker" description="This browser always plays through the system output." />
                    ) : null}
                    {loaded ? (
                        <SettingRow
                            id="camera"
                            label="Camera"
                            description={
                                cameras.length > 0
                                    ? "Sent to the target as a USB camera, from the camera button on the KVM screen. That needs a PiKVM V3 or V4 with the ucamera package and the OTG camera enabled."
                                    : "This browser found no camera. Plug one in and it is listed here."
                            }
                            control={<DeviceSelect label="Camera" storageKey={CAM_DEVICE_KEY} devices={cameras} />}
                        />
                    ) : null}
                    {loaded ? (
                        <SettingRow
                            id="camera-quality"
                            label="Camera quality"
                            description="Remembered for each camera. The PiKVM camera takes 1280 x 720 at most."
                            control={
                                <Select
                                    label="Camera quality"
                                    value={camera.choice.preset.id}
                                    options={CAMERA_PRESETS.map((preset) => ({ value: preset.id, label: presetText(preset) }))}
                                    onChange={(preset) => writeCameraPrefs(camera.device.id, { preset })}
                                />
                            }
                        />
                    ) : null}
                    {hidden ? (
                        <SettingRow
                            label="Device names are hidden"
                            description="The browser shows device names once you allow microphone access."
                            control={<Button onClick={() => void allowAccess()}>Allow access</Button>}
                        />
                    ) : null}
                    {error ? <SettingRow label="Audio devices" error={error} /> : null}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
