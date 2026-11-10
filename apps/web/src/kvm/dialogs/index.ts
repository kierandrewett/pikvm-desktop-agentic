/**
 * The KVM dialogs, registered into the screen's seam (kvm/dialog-seam.ts). The screen calls
 * `registerKvmDialogs()` once, after its placeholder registrations, so these win.
 */

import "./dialogs.css";
import { registerDialog } from "../dialog-seam";
import { AtxPowerDialog, AtxPowerLongDialog, AtxResetDialog } from "./atx-dialog";
import { AudioDevicesDialog } from "./audio-devices-dialog";
import { HealthDialog } from "./health-dialog";
import { LogDialog } from "./log-dialog";
import { MacrosDialog } from "./macros-dialog";
import { MsdDialog } from "./msd-dialog";
import { OcrDialog } from "./ocr-dialog";
import { PasteDialog } from "./paste-dialog";
import { StreamDialog } from "./stream-dialog";
import { RecordingsDialog } from "../recorder/recordings-dialog";

export function registerKvmDialogs(): void {
    registerDialog("paste", PasteDialog);
    registerDialog("stream", StreamDialog);
    registerDialog("audio-devices", AudioDevicesDialog);
    registerDialog("health", HealthDialog);
    registerDialog("msd", MsdDialog);
    registerDialog("ocr", OcrDialog);
    registerDialog("log", LogDialog);
    registerDialog("macros", MacrosDialog);
    registerDialog("atx-power", AtxPowerDialog);
    registerDialog("atx-power-long", AtxPowerLongDialog);
    registerDialog("atx-reset", AtxResetDialog);
    registerDialog("recordings", RecordingsDialog);
}
