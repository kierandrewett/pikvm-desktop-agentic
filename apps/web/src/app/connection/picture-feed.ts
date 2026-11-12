/**
 * The KVM screen's stream state, handed to the connection monitor. The picture controller lives inside the KVM pane;
 * the pane reports the signal here (the one its status chip and overlay show) and clears it when it unmounts, so the
 * banner can never word the picture differently from the overlay.
 */

import type { SignalState } from "@pikvm/kvm-engine";
import { appMonitor } from "./monitor";

export function reportPictureSignal(signal: SignalState | null): void {
    appMonitor().machine.setPicture(signal);
}
