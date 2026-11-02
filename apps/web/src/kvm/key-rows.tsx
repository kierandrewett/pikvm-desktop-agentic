/**
 * The keys a soft keyboard lacks, in the rows RustDesk's extra-keys bar uses: modifiers and
 * Esc/Tab/Fn/More always on screen, arrows and editing keys under them, and Fn and More opening
 * one extra block at a time so the block never grows past three rows beside the system keyboard.
 *
 * Modifiers are sticky: tap Ctrl, then a key, and the chord goes out; a second tap within a
 * moment locks it. They are the ONLY way to hold a modifier on a phone.
 */

import type { Keyboard } from "@pikvm/kvm-engine";
import type { FieldFocus } from "./field-focus";
import { useStore } from "./use-store";
import { useTarget } from "./session";

type KeyDef =
    | { readonly kind: "mod"; readonly code: string; readonly label: string }
    | { readonly kind: "key"; readonly code: string; readonly label: string; readonly name?: string }
    | { readonly kind: "chord"; readonly spec: string; readonly label: string; readonly name?: string }
    | { readonly kind: "cad" }
    | { readonly kind: "caps" };

const key = (code: string, label: string, name?: string): KeyDef => ({ kind: "key", code, label, ...(name ? { name } : {}) });
const chord = (spec: string, label: string, name?: string): KeyDef => ({ kind: "chord", spec, label, ...(name ? { name } : {}) });

export const MODIFIER_KEYS: readonly KeyDef[] = [
    { kind: "mod", code: "ControlLeft", label: "Ctrl" },
    { kind: "mod", code: "AltLeft", label: "Alt" },
    { kind: "mod", code: "ShiftLeft", label: "Shift" },
    { kind: "mod", code: "MetaLeft", label: "Win" },
];

const MAIN_ROW: readonly KeyDef[] = [...MODIFIER_KEYS, key("Escape", "Esc", "Escape"), key("Tab", "Tab")];

const NAV_ROW: readonly KeyDef[] = [
    key("ArrowLeft", "\u2190", "Left arrow"),
    key("ArrowUp", "\u2191", "Up arrow"),
    key("ArrowDown", "\u2193", "Down arrow"),
    key("ArrowRight", "\u2192", "Right arrow"),
    key("Enter", "\u23ce", "Enter"),
    key("Backspace", "\u232b", "Backspace"),
    key("Delete", "Del"),
    { kind: "caps" },
];

const FN_ROW: readonly KeyDef[] = Array.from({ length: 12 }, (_, i) => key(`F${i + 1}`, `F${i + 1}`));

const MORE_ROW: readonly KeyDef[] = [
    key("Home", "Home"),
    key("End", "End"),
    key("PageUp", "PgUp", "Page up"),
    key("PageDown", "PgDn", "Page down"),
    key("Insert", "Ins", "Insert"),
    key("PrintScreen", "PrtSc", "Print screen"),
    key("Pause", "Pause"),
    key("ScrollLock", "ScrLk", "Scroll lock"),
    key("ContextMenu", "Menu", "Context menu key"),
    chord("ControlLeft+KeyC", "Ctrl+C"),
    chord("ControlLeft+KeyV", "Ctrl+V"),
    chord("ControlLeft+KeyX", "Ctrl+X"),
    chord("ControlLeft+KeyZ", "Ctrl+Z"),
    chord("ControlLeft+KeyA", "Ctrl+A"),
    chord("ControlLeft+KeyS", "Ctrl+S"),
    chord("ControlLeft+KeyF", "Ctrl+F"),
    chord("AltLeft+Tab", "Alt+Tab"),
    chord("AltLeft+F4", "Alt+F4"),
    chord("MetaLeft+KeyD", "Win+D", "Win+D, show the desktop"),
    chord("MetaLeft+KeyR", "Win+R", "Win+R, run"),
    chord("MetaLeft+KeyL", "Win+L", "Win+L, lock the target"),
    { kind: "cad" },
];

export interface KeyButtonProps {
    readonly def: KeyDef;
    readonly keyboard: Keyboard;
    readonly focus: FieldFocus;
    readonly armed: readonly string[];
    readonly locked: readonly string[];
    readonly capsOn: boolean;
    readonly capsKnown: boolean;
}

function KeyButton({ def, keyboard, focus, armed, locked, capsOn, capsKnown }: KeyButtonProps) {
    const after = (): void => focus.refocus();
    switch (def.kind) {
        case "mod": {
            const on = armed.includes(def.code);
            return (
                <button
                    type="button"
                    className={`kvm-key${on ? " on" : ""}`}
                    data-mod={def.code}
                    aria-pressed={on}
                    title={locked.includes(def.code) ? `${def.label} is locked` : undefined}
                    onClick={() => {
                        keyboard.tapModifier(def.code);
                        after();
                    }}
                >
                    {def.label}
                    {locked.includes(def.code) ? <span className="kvm-key-lock" aria-hidden="true" /> : null}
                </button>
            );
        }
        case "key":
            return (
                <button
                    type="button"
                    className="kvm-key"
                    data-key={def.code}
                    aria-label={def.name}
                    onClick={() => {
                        keyboard.sendCode(def.code);
                        after();
                    }}
                >
                    {def.label}
                </button>
            );
        case "chord":
            return (
                <button
                    type="button"
                    className="kvm-key"
                    data-chord={def.spec}
                    aria-label={def.name}
                    onClick={() => {
                        keyboard.sendShortcut(def.spec);
                        after();
                    }}
                >
                    {def.label}
                </button>
            );
        case "cad":
            return (
                <button
                    type="button"
                    className="kvm-key"
                    data-chord="cad"
                    title="Ctrl+Alt+Del"
                    aria-label="C-A-D, send Ctrl+Alt+Del"
                    onClick={() => {
                        keyboard.sendChord(["ControlLeft", "AltLeft"], "Delete", false);
                        after();
                    }}
                >
                    C-A-D
                </button>
            );
        case "caps":
            // A toggle of REMOTE state, so aria-pressed tracks the Pi's LED, not the tap.
            return (
                <button
                    type="button"
                    className={`kvm-key${capsOn ? " on" : ""}`}
                    data-caps=""
                    aria-pressed={capsOn}
                    title={
                        capsKnown
                            ? `Caps Lock is ${capsOn ? "on" : "off"} on the target`
                            : "Caps Lock (the Pi has not reported the target's state yet)"
                    }
                    onClick={() => {
                        keyboard.sendChord([], "CapsLock", false);
                        after();
                    }}
                >
                    Caps
                </button>
            );
    }
}

export interface KeyRowsProps {
    readonly keyboard: Keyboard;
    readonly focus: FieldFocus;
    readonly fnOpen: boolean;
    readonly moreOpen: boolean;
    readonly onFn: () => void;
    readonly onMore: () => void;
}

export function KeyRows({ keyboard, focus, fnOpen, moreOpen, onFn, onMore }: KeyRowsProps) {
    const { armed, locked } = useStore(keyboard.armed);
    const capsOn = useTarget((s) => s.device.caps.on);
    const capsKnown = useTarget((s) => s.device.caps.known);
    const shared = { keyboard, focus, armed, locked, capsOn, capsKnown };
    const draw = (defs: readonly KeyDef[]) =>
        defs.map((def, i) => <KeyButton key={`${def.kind}:${"code" in def ? def.code : "spec" in def ? def.spec : i}`} def={def} {...shared} />);

    return (
        <div className="kvm-keys" role="group" aria-label="Controls">
            <div className="kvm-krow" role="group" aria-label="Modifiers">
                {draw(MAIN_ROW)}
                <button type="button" className={`kvm-key${fnOpen ? " on" : ""}`} aria-pressed={fnOpen} data-toggle="fn" onClick={() => { onFn(); focus.refocus(); }}>
                    Fn
                </button>
                <button
                    type="button"
                    className={`kvm-key${moreOpen ? " on" : ""}`}
                    aria-pressed={moreOpen}
                    aria-label="More keys"
                    data-toggle="more"
                    onClick={() => {
                        onMore();
                        focus.refocus();
                    }}
                >
                    More
                </button>
            </div>
            <div className="kvm-krow" role="group" aria-label="Navigation keys">
                {draw(NAV_ROW)}
            </div>
            {fnOpen ? (
                <div className="kvm-krow kvm-krow-wrap" role="group" aria-label="Function keys">
                    {draw(FN_ROW)}
                </div>
            ) : null}
            {moreOpen ? (
                <div className="kvm-krow kvm-krow-wrap" role="group" aria-label="More keys and shortcuts">
                    {draw(MORE_ROW)}
                </div>
            ) : null}
        </div>
    );
}

/** The same keys as one scrolling strip, for the desktop toolbar's drawer. */
export function KeyStrip({ keyboard, focus }: { readonly keyboard: Keyboard; readonly focus: FieldFocus }) {
    const { armed, locked } = useStore(keyboard.armed);
    const capsOn = useTarget((s) => s.device.caps.on);
    const capsKnown = useTarget((s) => s.device.caps.known);
    const shared = { keyboard, focus, armed, locked, capsOn, capsKnown };
    const strip: readonly KeyDef[] = [...MAIN_ROW, ...NAV_ROW, key("Home", "Home"), key("End", "End"), { kind: "cad" }];
    return (
        <div className="kvm-keys kvm-strip" role="group" aria-label="Controls">
            {strip.map((def, i) => (
                <KeyButton key={`${def.kind}:${"code" in def ? def.code : i}`} def={def} {...shared} />
            ))}
        </div>
    );
}
