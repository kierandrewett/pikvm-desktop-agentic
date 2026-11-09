/**
 * The ⋯ menu on a phone: a bottom sheet that is the dock grown upward (Office mobile's ribbon),
 * in flow so it pushes the picture up instead of covering it. Mouse buttons first (taps already
 * click, so they are rarely wanted), then the pinned macros as tiles, the input settings, the
 * audio switches, the action list and the view settings, each group under a rule.
 */

import type { Clock, Keyboard, TargetLink } from "@pikvm/kvm-engine";
import type { Action, ActionSections } from "./actions";
import type { DialogName } from "./dialog-seam";
import { MacroTiles } from "./macro-buttons";
import type { PictureController } from "./picture-controller";
import { useKvmSession, useTarget } from "./session";
import { usePictureState } from "./picture";
import type { TouchHid, TouchMode } from "../settings/local-prefs";

export interface SheetProps {
    readonly controller: PictureController | null;
    readonly actions: ActionSections;
    readonly touchMode: TouchMode;
    readonly touchHid: TouchHid;
    readonly onTouchMode: (mode: TouchMode) => void;
    readonly onTouchHid: (hid: TouchHid) => void;
    readonly dragLock: boolean;
    readonly onDragLock: (on: boolean) => void;
    readonly openDialog: (name: DialogName) => void;
    readonly onClose: () => void;
}

/** A click is a press that comes up a moment later; armed sticky modifiers ride around it. */
export function sendClick(link: TargetLink, keyboard: Keyboard, clock: Clock, button: "left" | "middle" | "right"): void {
    keyboard.withArmedModifiers((release) => {
        link.button(button, true);
        clock.setTimeout(() => {
            link.button(button, false);
            release();
        }, 45);
    });
}

export function sendScroll(link: TargetLink, keyboard: Keyboard, up: boolean): void {
    keyboard.withArmedModifiers((release) => {
        link.wheel(0, up ? 2 : -2);
        release();
    });
}

/** Left, middle and right click, hold-left (drag-lock), and scroll: the mouse as a row of keys. */
export function MouseButtons({ dragLock, onDragLock }: { readonly dragLock: boolean; readonly onDragLock: (on: boolean) => void }) {
    const { link, keyboard, clock } = useKvmSession();
    return (
        <>
            {(["left", "middle", "right"] as const).map((button) => (
                <button
                    key={button}
                    type="button"
                    className="kvm-key"
                    data-click={button}
                    title={`${button[0]?.toUpperCase()}${button.slice(1)} click`}
                    aria-label={`${button[0]?.toUpperCase()}, ${button} click`}
                    onClick={() => sendClick(link, keyboard, clock, button)}
                >
                    {button[0]?.toUpperCase()}
                </button>
            ))}
            <button
                type="button"
                className={`kvm-key${dragLock ? " on" : ""}`}
                aria-pressed={dragLock}
                title="Hold left (drag)"
                aria-label="Hold the left mouse button down, to drag"
                data-drag-lock=""
                onClick={() => onDragLock(!dragLock)}
            >
                {"\u291e"}
            </button>
            <button type="button" className="kvm-key" data-scroll="up" title="Scroll up" aria-label="Scroll up" onClick={() => sendScroll(link, keyboard, true)}>
                {"\u25b2"}
            </button>
            <button type="button" className="kvm-key" data-scroll="down" title="Scroll down" aria-label="Scroll down" onClick={() => sendScroll(link, keyboard, false)}>
                {"\u25bc"}
            </button>
        </>
    );
}

function ActionButton({ action, onDone }: { action: Action; onDone: () => void }) {
    return (
        <button
            type="button"
            className="kvm-item"
            disabled={action.disabled}
            onClick={() => {
                onDone();
                action.run();
            }}
        >
            {action.label}
        </button>
    );
}

function Group({ actions, onDone }: { actions: readonly Action[]; onDone: () => void }) {
    return (
        <>
            {actions.map((action) => (
                <ActionButton key={action.id} action={action} onDone={onDone} />
            ))}
        </>
    );
}

export function Sheet(props: SheetProps) {
    const { controller, actions, touchMode, touchHid, dragLock, onClose } = props;
    const picture = usePictureState(controller);
    const relativeAvailable = useTarget((s) => s.device.mouse.outputs.includes("usb_rel"));
    const relative = useTarget((s) => s.device.mouse.absolute === false);
    const direct = touchMode === "direct";
    const rel = touchHid === "rel";
    // Asked for, not yet reported by the Pi.
    const pending = touchMode === "trackpad" && relative === (touchHid === "abs");
    const { audio } = picture;
    const hasPower = actions.power.length > 0;

    return (
        <div className="kvm-sheet" id="kvm-sheet" role="group" aria-label="More">
            <div className="kvm-sheet-label">Mouse</div>
            <div className="kvm-sheet-row" role="group" aria-label="Mouse buttons">
                <MouseButtons dragLock={dragLock} onDragLock={props.onDragLock} />
            </div>

            <MacroTiles onRun={onClose} />

            {/* Settings you rarely change. Toggles keep the sheet open, the same as the audio switches. */}
            <button
                type="button"
                className="kvm-item toggle"
                data-setting="touch-mode"
                title={
                    direct
                        ? "Touch: tap where you want to click. Tap to switch to trackpad."
                        : "Trackpad: drag to move the cursor, tap to click. Tap to switch to touch."
                }
                aria-label={`Touch input: ${direct ? "touch" : "trackpad"}`}
                onClick={() => props.onTouchMode(direct ? "trackpad" : "direct")}
            >
                <span>Touch input</span>
                <span className="kvm-pip">{direct ? "Touch" : "Trackpad"}</span>
            </button>
            {touchMode === "trackpad" && relativeAvailable ? (
                <button
                    type="button"
                    className={`kvm-item toggle${pending ? " pending" : ""}`}
                    data-setting="touch-hid"
                    title={
                        rel
                            ? "Relative mouse: works with any target, the cursor follows the picture. Tap for absolute."
                            : "Absolute mouse: exact cursor position. Tap for relative."
                    }
                    aria-label={`Trackpad mouse mode: ${rel ? "relative" : "absolute"}`}
                    onClick={() => props.onTouchHid(rel ? "abs" : "rel")}
                >
                    <span>Trackpad mouse</span>
                    <span className="kvm-pip">{rel ? "Relative" : "Absolute"}</span>
                </button>
            ) : null}
            <div className="kvm-sep" />

            {audio.available ? (
                <>
                    <button
                        type="button"
                        className={`kvm-item toggle${audio.audioOn && !audio.blocked ? " on" : ""}`}
                        data-setting="audio"
                        aria-pressed={audio.audioOn && !audio.blocked}
                        onClick={() => controller?.toggleAudio()}
                    >
                        <span>Audio output</span>
                        <span className="kvm-pip">{audio.blocked ? "Tap to turn on" : audio.audioOn ? "On" : "Off"}</span>
                    </button>
                    <button
                        type="button"
                        className={`kvm-item toggle${audio.micOn ? " on" : ""}${audio.micWarn ? " warn" : ""}`}
                        data-setting="mic"
                        aria-pressed={audio.micOn}
                        onClick={() => controller?.toggleMic()}
                    >
                        <span>Microphone</span>
                        <span className="kvm-pip">{audio.micLabel}</span>
                    </button>
                    <button type="button" className="kvm-item" onClick={() => { onClose(); props.openDialog("audio-devices"); }}>
                        Audio devices
                    </button>
                    <div className="kvm-sep" />
                </>
            ) : null}

            <Group actions={actions.tools} onDone={onClose} />

            {hasPower ? <div className="kvm-sep" /> : null}
            <Group actions={actions.power} onDone={onClose} />

            {/* Always shown: it closes the actions above (and the power group, when there is one) off from the view settings below. */}
            <div className="kvm-sep" />
            <Group actions={actions.view} onDone={onClose} />
        </div>
    );
}
