/**
 * What the screen can do besides typing and pointing: the entries of the phone sheet's action
 * list and the desktop toolbar's menus, built once so both say the same things. Anything that
 * needs a window of its own is an `openDialog` call; the rest happens here.
 */

import { errorMessage } from "@pikvm/kvm-engine";
import { useMemo, useState } from "react";
import { currentTheme, setThemeChoice } from "../theme";
import type { DialogName } from "./dialog-seam";
import { awaitDownload, fullscreenSupported, isDesktopApp, saveScreenshot, toggleFullscreen } from "./platform";
import { useKvmSession, useTarget } from "./session";

export interface Action {
    readonly id: string;
    readonly label: string;
    readonly run: () => void;
    readonly disabled?: boolean;
    readonly checked?: boolean;
}

export interface ActionSections {
    /** Paste, stream, screenshot, health, storage, text from the screen, log, macros. */
    readonly tools: readonly Action[];
    /** ATX power: empty unless the Pi reports the wiring. */
    readonly power: readonly Action[];
    /** Full screen, theme, the Pi's own UI. */
    readonly view: readonly Action[];
}

export interface ATXAction {
    readonly dialog: "atx-power" | "atx-power-long" | "atx-reset";
    readonly label: string;
}

/** Each opens its own confirmation: every one can cost the operator unsaved work, so none fires on a stray tap. */
export const ATX_ACTIONS: readonly ATXAction[] = [
    { dialog: "atx-power", label: "Power button" },
    { dialog: "atx-power-long", label: "Power button (hold 5s)" },
    { dialog: "atx-reset", label: "Reset" },
];

/** The shortcuts a keyboard on this side of the glass cannot send to the target. */
export interface Shortcut {
    readonly id: string;
    readonly label: string;
    readonly mods: readonly string[];
    readonly code: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
    { id: "cad", label: "Ctrl + Alt + Delete", mods: ["ControlLeft", "AltLeft"], code: "Delete" },
    { id: "taskmgr", label: "Ctrl + Shift + Esc  (Task Manager)", mods: ["ControlLeft", "ShiftLeft"], code: "Escape" },
    { id: "alttab", label: "Alt + Tab", mods: ["AltLeft"], code: "Tab" },
    { id: "altf4", label: "Alt + F4  (Close window)", mods: ["AltLeft"], code: "F4" },
    { id: "win", label: "Windows / Super key", mods: [], code: "MetaLeft" },
    { id: "wind", label: "Win + D  (Show desktop)", mods: ["MetaLeft"], code: "KeyD" },
    { id: "winl", label: "Win + L  (Lock)", mods: ["MetaLeft"], code: "KeyL" },
    { id: "winr", label: "Win + R  (Run)", mods: ["MetaLeft"], code: "KeyR" },
    { id: "prtsc", label: "Print Screen", mods: [], code: "PrintScreen" },
    { id: "esc", label: "Escape", mods: [], code: "Escape" },
];

export interface ActionInputs {
    readonly openDialog: (name: DialogName) => void;
    /** Show or leave the Pi's own UI over the picture; null where the mode cannot (snapshot targets). */
    readonly toggleFullUi: (() => void) | null;
    readonly fullUiOn: boolean;
    readonly isFullscreen: boolean;
    /** The "tell me when the screen changes" switch; null where the page is suspended in the background (a phone). */
    readonly screenAlerts: { readonly on: boolean; readonly toggle: () => void } | null;
}

export function useActions(inputs: ActionInputs): ActionSections {
    const session = useKvmSession();
    const msdEnabled = useTarget((s) => s.device.msd?.enabled === true);
    const ocrEnabled = useTarget((s) => s.device.ocr?.enabled === true);
    const atxEnabled = useTarget((s) => s.device.atx?.enabled === true);
    const atxBusy = useTarget((s) => s.device.atx?.busy === true);
    const [shooting, setShooting] = useState(false);
    const { openDialog, toggleFullUi, fullUiOn, isFullscreen, screenAlerts } = inputs;
    const alertsOn = screenAlerts?.on;
    const alertsToggle = screenAlerts?.toggle;

    return useMemo<ActionSections>(() => {
        const { notify } = session.notices;

        const shoot = (): void => {
            setShooting(true);
            saveScreenshot()
                .then(awaitDownload)
                .then((state) => {
                    if (state === "completed") notify({ text: "Screenshot saved" });
                    else if (state === "cancelled") notify({ text: "Screenshot not saved" });
                    else notify({ text: "Screenshot save failed", error: true });
                })
                .catch((e: unknown) => notify({ text: errorMessage(e), error: true }))
                .finally(() => setShooting(false));
        };

        const tools: Action[] = [
            { id: "paste", label: "Paste text to the target", run: () => openDialog("paste") },
            { id: "stream", label: "Stream settings", run: () => openDialog("stream") },
            { id: "screenshot", label: "Save screenshot", run: shoot, disabled: shooting },
            { id: "health", label: "System, GPIO and health", run: () => openDialog("health") },
        ];
        if (msdEnabled) tools.push({ id: "msd", label: "Mass storage", run: () => openDialog("msd") });
        if (ocrEnabled) tools.push({ id: "ocr", label: "Read text from the screen", run: () => openDialog("ocr") });
        tools.push(
            { id: "log", label: "PiKVM log", run: () => openDialog("log") },
            { id: "macros", label: "Macros", run: () => openDialog("macros") },
        );

        const power: Action[] = atxEnabled
            ? ATX_ACTIONS.map((a) => ({ id: a.dialog, label: a.label, run: () => openDialog(a.dialog), disabled: atxBusy }))
            : [];

        const view: Action[] = [];
        if (fullscreenSupported()) {
            view.push({
                id: "fullscreen",
                label: isFullscreen ? "Exit full screen" : "Full screen (send Win and Alt keys)",
                run: () => {
                    void toggleFullscreen().then((ok) => {
                        if (!ok) notify({ text: "Full screen was refused by the browser", error: true });
                    });
                },
            });
        }
        view.push({
            id: "theme",
            label: "Toggle theme",
            run: () => setThemeChoice(currentTheme() === "dark" ? "light" : "dark"),
        });
        if (alertsToggle) {
            view.push({
                id: "screen-alerts",
                label: isDesktopApp() ? "Pulse the taskbar when the screen changes" : "Alert me when the screen changes",
                checked: alertsOn === true,
                run: alertsToggle,
            });
        }
        if (toggleFullUi) {
            view.push({ id: "full-ui", label: fullUiOn ? "Back to console" : "Full PiKVM UI", run: toggleFullUi });
        }
        return { tools, power, view };
    }, [session, openDialog, toggleFullUi, fullUiOn, isFullscreen, alertsOn, alertsToggle, msdEnabled, ocrEnabled, atxEnabled, atxBusy, shooting]);
}
