/**
 * Preferences that live in this browser only, under the keys and values the console already
 * reads at boot. They are not settings on the server because they describe the hand holding
 * the device, not the target.
 */

import { useCallback, useSyncExternalStore } from "react";

export const TOUCH_MODE_KEY = "pikvm-touch-mode";
export const TOUCH_HID_KEY = "pikvm-touch-hid";
export const MIC_DEVICE_KEY = "pikvm-console-mic-device";
export const OUT_DEVICE_KEY = "pikvm-console-speaker-device";
export const CAM_DEVICE_KEY = "pikvm-console-camera-device";

export type TouchMode = "trackpad" | "direct";
export type TouchHid = "abs" | "rel";

/** What the console reads: "direct" means direct, anything else is the trackpad. */
export const readTouchMode = (): TouchMode => (readString(TOUCH_MODE_KEY) === "direct" ? "direct" : "trackpad");

/** What the console reads: "rel" means relative, anything else is absolute. */
export const readTouchHid = (): TouchHid => (readString(TOUCH_HID_KEY) === "rel" ? "rel" : "abs");

function readString(key: string): string {
    try {
        return localStorage.getItem(key) ?? "";
    } catch {
        return "";
    }
}

const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // Another tab (or the console in a frame) writing the same key.
    window.addEventListener("storage", listener);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", listener);
    };
}

export function writeString(key: string, value: string | undefined): void {
    try {
        if (value === undefined || value === "") localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Storage unavailable: the choice lasts for this page only.
    }
    notify();
}

export function useStoredValue<T extends string>(key: string, read: () => T): [T, (value: T) => void] {
    const value = useSyncExternalStore(subscribe, read, read);
    const write = useCallback((next: T) => writeString(key, next), [key]);
    return [value, write];
}

export interface DeviceChoice {
    id: string;
    label: string;
}

/** Same shape the console writes: the label rides along so an unplugged device can be named. */
export function readDeviceChoice(key: string): DeviceChoice {
    const raw = readString(key);
    if (!raw) return { id: "", label: "" };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return { id: "", label: "" };
        const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : "";
        const label = "label" in parsed && typeof parsed.label === "string" ? parsed.label : "";
        return { id, label };
    } catch {
        return { id: "", label: "" };
    }
}

export function writeDeviceChoice(key: string, choice: DeviceChoice): void {
    writeString(key, choice.id ? JSON.stringify(choice) : undefined);
}
