/**
 * Audio device discovery for the Audio page, over navigator.mediaDevices.
 *
 * The rules are the console's: "default" and "communications" are aliases for whatever the OS
 * prefers right now, so pinning to one pins to the moving target the choice exists to avoid;
 * they are dropped and the first option says "Follow the system default" instead. And a
 * device's label is stored beside its id, because an unplugged device is not listed at all and
 * that is exactly when it needs a name.
 */

import { useCallback, useEffect, useState } from "react";

const DEVICE_ALIASES = ["default", "communications"];

export type DeviceKind = "audioinput" | "audiooutput";

export interface AudioDevice {
    readonly id: string;
    readonly label: string;
}

export const audioDevicesSupported = (): boolean =>
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.enumerateDevices === "function";

/** Choosing where audio plays needs setSinkId, which Safari and Firefox lack. */
export const speakerSelectionSupported = (): boolean =>
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** Real devices of one kind, without the OS aliases. */
export function collectDevices(all: ReadonlyArray<MediaDeviceInfo>, kind: DeviceKind): ReadonlyArray<AudioDevice> {
    return all
        .filter((device) => device.kind === kind && device.deviceId !== "" && !DEVICE_ALIASES.includes(device.deviceId))
        .map((device) => ({ id: device.deviceId, label: device.label }));
}

/** enumerateDevices leaves every label empty until microphone access has been granted once. */
export const labelsHidden = (devices: ReadonlyArray<AudioDevice>): boolean =>
    devices.length > 0 && devices.every((device) => device.label === "");

export interface AudioDevices {
    readonly inputs: ReadonlyArray<AudioDevice>;
    readonly outputs: ReadonlyArray<AudioDevice>;
    readonly loaded: boolean;
    readonly error: string | undefined;
    /** Ask for microphone access once so the browser reveals device names. */
    readonly allowAccess: () => Promise<void>;
}

export function useAudioDevices(): AudioDevices {
    const [all, setAll] = useState<ReadonlyArray<MediaDeviceInfo>>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string>();

    const refresh = useCallback(async () => {
        try {
            setAll(await navigator.mediaDevices.enumerateDevices());
            setError(undefined);
        } catch {
            setError("Could not list audio devices.");
        }
        setLoaded(true);
    }, []);

    useEffect(() => {
        void refresh();
        const media = navigator.mediaDevices;
        media.addEventListener?.("devicechange", refresh);
        return () => media.removeEventListener?.("devicechange", refresh);
    }, [refresh]);

    const allowAccess = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) track.stop();
            setError(undefined);
        } catch {
            setError("Microphone access was not granted, so device names stay hidden.");
        }
        await refresh();
    }, [refresh]);

    return {
        inputs: collectDevices(all, "audioinput"),
        outputs: collectDevices(all, "audiooutput"),
        loaded,
        error,
        allowAccess,
    };
}
