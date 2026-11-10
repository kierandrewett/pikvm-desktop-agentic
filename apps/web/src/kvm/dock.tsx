/**
 * The phone dock: every control at the bottom, directly above the soft keyboard (Termius and
 * RustDesk style), with the picture taking the rest. A status row on top (dot and word, speaker,
 * mic, zoom-out, paste, keyboard, more), the key rows under it, and the ⋯ sheet replacing the
 * key rows when it opens.
 *
 * Nothing in the dock may take focus from the hidden field, or the system keyboard drops every
 * time a key is used: a press on a button is held off (pointerdown, and on iOS the mouse event
 * that follows it) and the focus is handed straight back if the keyboard was up.
 */

import { useEffect, useRef, useState } from "react";
import type { ActionSections } from "./actions";
import type { DialogName } from "./dialog-seam";
import type { FieldFocus } from "./field-focus";
import { useStatusChip } from "./first-run";
import {
    ClipboardText,
    DotsThree,
    Keyboard,
    MagnifyingGlassMinus,
    Microphone,
    SpeakerHigh,
    SpeakerSimpleNone,
} from "@pikvm/icons";
import { CameraToggle } from "./camera-control";
import { HealthButton } from "./health-button";
import { KeyRows } from "./key-rows";
import type { PictureController } from "./picture-controller";
import { RecordButton } from "./recorder/record-button";
import { usePictureState } from "./picture";
import { useKvmActive } from "./active";
import { useKvmLocked } from "./locked";
import { useKvmSession, useTarget } from "./session";
import { Sheet } from "./sheet";
import { useStore } from "./use-store";
import type { TouchHid, TouchMode } from "../settings/local-prefs";

export interface DockProps {
    readonly controller: PictureController | null;
    readonly focus: FieldFocus;
    readonly actions: ActionSections;
    readonly touchMode: TouchMode;
    readonly touchHid: TouchHid;
    readonly onTouchMode: (mode: TouchMode) => void;
    readonly onTouchHid: (hid: TouchHid) => void;
    readonly dragLock: boolean;
    readonly onDragLock: (on: boolean) => void;
    readonly openDialog: (name: DialogName) => void;
}

export function Dock(props: DockProps) {
    const { controller, focus } = props;
    const session = useKvmSession();
    const active = useKvmActive();
    const agentHolds = useKvmLocked();
    const picture = usePictureState(controller);
    const inputOpen = useTarget((s) => s.link.open);
    const { focused } = useStore(focus.store);
    const [sheet, setSheet] = useState(false);
    const [fnOpen, setFnOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const moreButton = useRef<HTMLButtonElement>(null);
    const audioButton = useRef<HTMLButtonElement>(null);
    const micButton = useRef<HTMLButtonElement>(null);

    const setSheetOpen = (open: boolean): void => {
        setSheet(open);
        if (open) {
            // On a phone the menu is the bar grown upward: the system keyboard goes away so the
            // sheet has the room, and nothing reopens it afterwards; the keyboard button is right there.
            focus.release();
        }
    };

    // Outside taps and Escape put the sheet away. Only while the KVM is in front: an Escape typed
    // on another tab is not for this sheet.
    useEffect(() => {
        if (!sheet || !active) return;
        const onDown = (e: PointerEvent): void => {
            const target = e.target;
            if (!(target instanceof Node)) return;
            if (root.current?.querySelector("#kvm-sheet")?.contains(target) || moreButton.current?.contains(target)) return;
            setSheet(false);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            setSheet(false);
        };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [sheet, active]);

    useEffect(() => {
        const offA = controller?.bindMeter("audio", audioButton.current);
        const offM = controller?.bindMeter("mic", micButton.current);
        return () => {
            offA?.();
            offM?.();
        };
    }, [controller, picture.audio.available]);

    const { tone, label } = useStatusChip(picture.signal, inputOpen);
    const { audio } = picture;

    return (
        <div
            ref={root}
            className="kvm-bar"
            data-sheet={sheet}
            onPointerDown={(e) => {
                if (!(e.target instanceof Element) || !e.target.closest("button")) return;
                focus.notePress();
                if (e.pointerType !== "mouse") e.preventDefault();
            }}
            onMouseDown={(e) => {
                // The compatibility mousedown is what moves focus on iOS, so it is held off too.
                if (e.target instanceof Element && e.target.closest("button") && focus.recentPress()) e.preventDefault();
            }}
        >
            {sheet ? (
                <Sheet
                    controller={controller}
                    actions={props.actions}
                    touchMode={props.touchMode}
                    touchHid={props.touchHid}
                    onTouchMode={props.onTouchMode}
                    onTouchHid={props.onTouchHid}
                    dragLock={props.dragLock}
                    onDragLock={props.onDragLock}
                    openDialog={props.openDialog}
                    onClose={() => setSheetOpen(false)}
                />
            ) : null}

            <div className="kvm-bar-main" inert={agentHolds || undefined}>
                <span className={`kvm-dot ${tone}`} title={label} role="img" aria-label={label} />
                <span className="kvm-status">{label}</span>
                <span className="kvm-spacer" />
                <HealthButton className="kvm-ibtn" openDialog={props.openDialog} />
                {audio.available ? (
                    <>
                        <button
                            ref={audioButton}
                            type="button"
                            className={`kvm-ibtn kvm-av${audio.audioOn && !audio.blocked ? " on" : ""}`}
                            data-tb="audio"
                            {...(audio.blocked ? { "data-waiting": "true", title: "Tap to turn on sound" } : {})}
                            aria-pressed={audio.audioOn && !audio.blocked}
                            aria-label="Audio output"
                            onClick={() => controller?.toggleAudio()}
                        >
                            {audio.audioOn && !audio.blocked ? <SpeakerHigh weight="fill" /> : <SpeakerSimpleNone />}
                        </button>
                        <button
                            ref={micButton}
                            type="button"
                            className={`kvm-ibtn kvm-av${audio.micOn ? " on" : ""}${audio.micWarn ? " warn" : ""}`}
                            data-tb="mic"
                            aria-pressed={audio.micOn}
                            aria-label="Microphone"
                            title={audio.micWarn ? audio.micLabel : undefined}
                            onClick={() => controller?.toggleMic()}
                        >
                            <Microphone weight={audio.micOn ? "fill" : "regular"} />
                        </button>
                    </>
                ) : null}
                <CameraToggle controller={controller} variant="dock" />
                <RecordButton variant="dock" />
                {picture.scale > 1 ? (
                    <button
                        type="button"
                        className="kvm-ibtn"
                        data-testid="zoom-reset"
                        title="Zoom out to the whole screen"
                        aria-label="Zoom out to the whole screen"
                        onClick={() => {
                            controller?.resetZoom();
                            focus.refocus();
                        }}
                    >
                        <MagnifyingGlassMinus />
                    </button>
                ) : null}
                <button
                    type="button"
                    className="kvm-ibtn"
                    title="Type text on the target"
                    aria-label="Type text on the target"
                    onClick={() => props.openDialog("paste")}
                >
                    <ClipboardText />
                </button>
                <button
                    type="button"
                    className={`kvm-ibtn${focused ? " on" : ""}`}
                    data-testid="keyboard-toggle"
                    title="Show or hide the keyboard"
                    aria-label="Keyboard"
                    aria-pressed={focused}
                    onClick={() => focus.toggle()}
                >
                    <Keyboard />
                </button>
                <button
                    ref={moreButton}
                    type="button"
                    className={`kvm-ibtn${sheet ? " on" : ""}`}
                    title="More"
                    aria-label="More"
                    aria-expanded={sheet}
                    aria-controls="kvm-sheet"
                    onClick={() => setSheetOpen(!sheet)}
                >
                    <DotsThree weight="bold" />
                </button>
            </div>

            {sheet ? null : (
                <KeyRows
                    keyboard={session.keyboard}
                    focus={focus}
                    fnOpen={fnOpen}
                    moreOpen={moreOpen}
                    onFn={() => {
                        setFnOpen(!fnOpen);
                        setMoreOpen(false);
                    }}
                    onMore={() => {
                        setMoreOpen(!moreOpen);
                        setFnOpen(false);
                    }}
                />
            )}
        </div>
    );
}
