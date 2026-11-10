/**
 * The Record control, in the three places the other switches live: the desktop toolbar and the phone dock (a round
 * button that grows a timer while recording) and the phone sheet (a row with a pip). All three read the same view
 * (use-recorder.ts), so they agree on when it is off, why, and what it says while recording, and all three show a
 * recording another client started.
 */

import { Record as RecordIcon } from "@pikvm/icons";
import { recordButtonView, useRecorder, useRecordUi } from "./use-recorder";
import "./recorder.css";

export type RecordButtonVariant = "toolbar" | "dock";

function useRecordControl() {
    const recorder = useRecorder();
    const ui = useRecordUi(recorder);
    const view = recordButtonView(ui);
    const toggle = (): void => {
        if (!recorder) return;
        void (view.recording ? recorder.stop() : recorder.start());
    };
    return { view, toggle };
}

export function RecordButton({ variant }: { readonly variant: RecordButtonVariant }) {
    const { view, toggle } = useRecordControl();
    const base = variant === "toolbar" ? "kvm-tb-btn" : "kvm-ibtn";
    return (
        <button
            type="button"
            className={`${base} kvm-rec${view.recording ? " is-recording" : ""}${view.warn ? " warn" : ""}`}
            data-tb="record"
            data-recording={view.recording || undefined}
            aria-pressed={view.recording}
            aria-label={view.label}
            title={view.title}
            disabled={view.disabled}
            onClick={toggle}
        >
            <RecordIcon weight={view.recording ? "fill" : "regular"} />
            {view.recording ? <span className="kvm-rec-clock">{view.clock}</span> : null}
        </button>
    );
}

/** The sheet's row: "Record session", with the timer where the other rows show their state. */
export function RecordSheetItem() {
    const { view, toggle } = useRecordControl();
    return (
        <button
            type="button"
            className={`kvm-item toggle kvm-rec-item${view.recording ? " on is-recording" : ""}${view.warn ? " warn" : ""}`}
            data-setting="record"
            aria-pressed={view.recording}
            title={view.title}
            disabled={view.disabled}
            onClick={toggle}
        >
            <span>Record session</span>
            <span className="kvm-pip">{view.recording ? view.clock : view.busy ? "..." : "Off"}</span>
        </button>
    );
}
