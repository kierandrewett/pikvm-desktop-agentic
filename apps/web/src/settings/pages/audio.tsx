import { useState } from "react";
import { Group, InlineError, Row } from "../../ui/controls";
import {
    type DeviceChoice,
    MIC_DEVICE_KEY,
    OUT_DEVICE_KEY,
    readDeviceChoice,
    writeDeviceChoice,
} from "../local-prefs";
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

    return (
        <select
            className="field-select"
            aria-label={label}
            value={choice.id}
            onChange={(event) => {
                const id = event.target.value;
                const picked = devices.find((device) => device.id === id);
                const next = { id, label: picked?.label || choice.label };
                const stored = id ? next : { id: "", label: "" };
                writeDeviceChoice(storageKey, stored);
                setChoice(stored);
            }}
        >
            <option value="">Follow the system default</option>
            {choice.id && !known ? (
                // Pinned to a device that is not here: say so rather than quietly showing another.
                <option value={choice.id}>{choice.label || "Chosen device"} (not connected)</option>
            ) : null}
            {devices.map((device, index) => (
                <option key={device.id} value={device.id}>
                    {device.label || `${label} ${index + 1}`}
                </option>
            ))}
        </select>
    );
}

export function AudioPage() {
    const { inputs, outputs, loaded, error, allowAccess } = useAudioDevices();
    const hidden = labelsHidden(inputs) || labelsHidden(outputs);

    return (
        <Group
            title="Devices"
            footer="Used for the target's sound and your microphone in the KVM screen. A chosen device that is unplugged is reported, not swapped for another."
        >
            {loaded ? (
                <Row label="Microphone">
                    <DeviceSelect label="Microphone" storageKey={MIC_DEVICE_KEY} devices={inputs} />
                </Row>
            ) : null}
            {loaded && speakerSelectionSupported() ? (
                <Row label="Speaker">
                    <DeviceSelect label="Speaker" storageKey={OUT_DEVICE_KEY} devices={outputs} />
                </Row>
            ) : null}
            {loaded && !speakerSelectionSupported() ? (
                <Row label="Speaker" hint="This browser always plays through the system output." />
            ) : null}
            {hidden ? (
                <Row label="Device names are hidden" hint="The browser shows names after microphone access is allowed once.">
                    <button type="button" className="btn" onClick={() => void allowAccess()}>
                        Allow access
                    </button>
                </Row>
            ) : null}
            {error ? <InlineError>{error}</InlineError> : null}
        </Group>
    );
}
