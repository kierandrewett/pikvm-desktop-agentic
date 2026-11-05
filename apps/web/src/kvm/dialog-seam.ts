/**
 * The seam between the KVM screen and its dialogs.
 *
 * The screen only ever says `openDialog("stream")`. What appears is whatever component is
 * registered under that name: `dialog-defaults.tsx` registers a working paste dialog and a
 * plain "not built yet" panel for the rest, and the dialogs module replaces each with the real
 * one by calling `registerDialog` after it (the last registration for a name wins).
 */

import { createStore, type ReadableStore } from "@pikvm/kvm-engine";
import type { ComponentType } from "react";
import type { KvmSession } from "./session";

export const DIALOG_NAMES = [
    "paste",
    "stream",
    "audio-devices",
    "health",
    "msd",
    "ocr",
    "log",
    "macros",
    "atx-power",
    "atx-power-long",
    "atx-reset",
] as const;
export type DialogName = (typeof DIALOG_NAMES)[number];

/** Titles for the plain panel and for assistive technology until a real dialog is registered. */
export const DIALOG_TITLES: Readonly<Record<DialogName, string>> = {
    paste: "Type text on the target",
    stream: "Stream settings",
    "audio-devices": "Audio devices",
    health: "System, GPIO and health",
    msd: "Mass storage",
    ocr: "Text from the screen",
    log: "PiKVM log",
    macros: "Macros",
    "atx-power": "Press the power button?",
    "atx-power-long": "Hold the power button?",
    "atx-reset": "Press the reset button?",
};

export interface DialogState {
    readonly open: DialogName | null;
}

export interface DialogCenter {
    readonly store: ReadableStore<DialogState>;
    open(name: DialogName): void;
    close(): void;
}

export function createDialogCenter(): DialogCenter {
    const store = createStore<DialogState>({ open: null });
    return {
        store,
        open: (name) => store.setState({ open: name }),
        close: () => store.setState({ open: null }),
    };
}

/** What every registered dialog receives. It closes itself through `onClose`. */
export interface DialogProps {
    readonly session: KvmSession;
    readonly onClose: () => void;
}

export type DialogComponent = ComponentType<DialogProps>;

const registry = new Map<DialogName, DialogComponent>();

export function registerDialog(name: DialogName, component: DialogComponent): void {
    registry.set(name, component);
}

export function dialogFor(name: DialogName): DialogComponent | undefined {
    return registry.get(name);
}
