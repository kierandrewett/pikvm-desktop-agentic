/**
 * The dialogs that exist before the dialogs module does: a working paste dialog (the dock's
 * paste button and Ctrl+Enter need something real to talk to) and a plain panel for the rest.
 * The dialogs module registers over them.
 */

import { humanCount, keymapChoice, pasteDuration } from "@pikvm/kvm-engine";
import { useEffect, useState } from "react";
import { DIALOG_NAMES, DIALOG_TITLES, registerDialog, type DialogProps } from "./dialog-seam";
import { ModalFrame } from "./modal-frame";
import { useTarget } from "./session";
import { useStore } from "./use-store";

export function PasteDialog({ session, onClose }: DialogProps) {
    const [text, setText] = useState("");
    const keymaps = useTarget((s) => s.device.keymaps);
    const choice = keymapChoice(keymaps);
    const chosen = useStore(session.keymap);
    const selected = chosen ?? choice.selected ?? "";

    // Prefilled from the host clipboard, the thing people paste. Best effort: a browser that
    // asks, or refuses, just leaves the field empty.
    useEffect(() => {
        let alive = true;
        navigator.clipboard?.readText?.().then(
            (clip) => {
                if (alive && clip) setText((current) => current || clip);
            },
            () => {},
        );
        return () => {
            alive = false;
        };
    }, []);

    const send = (): void => {
        if (!text) return;
        onClose();
        void session.paster.paste(text);
    };
    const duration = pasteDuration(text.length);

    return (
        <ModalFrame
            title="Paste text to the target"
            onClose={onClose}
            actions={
                <>
                    <button type="button" className="kvm-btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button type="button" className="kvm-btn primary" disabled={!text} onClick={send}>
                        Type on target
                    </button>
                </>
            }
        >
            <textarea
                className="kvm-textarea"
                data-autofocus=""
                rows={6}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Text to type on the target"
                placeholder={"Text to type on the target\u2026"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        send();
                    }
                }}
            />
            <div className="kvm-dialog-row">
                {choice.hidden ? null : (
                    <>
                        <label className="kvm-dialog-label" htmlFor="kvm-paste-keymap">
                            Keymap
                        </label>
                        <select
                            id="kvm-paste-keymap"
                            className="kvm-select"
                            value={selected}
                            disabled={choice.disabled}
                            onChange={(e) => session.keymap.setState(e.target.value || null)}
                        >
                            {choice.options.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </>
                )}
                <span className="kvm-dialog-hint">
                    {text ? `${humanCount(text.length)} ${text.length === 1 ? "character" : "characters"}` : ""}
                    {duration ? ` \u00b7 ${duration}` : ""}
                </span>
            </div>
        </ModalFrame>
    );
}

/** What stands in for a dialog whose real component has not been registered. */
export function UnavailableDialog({ name, onClose }: DialogProps & { name: (typeof DIALOG_NAMES)[number] }) {
    return (
        <ModalFrame
            title={DIALOG_TITLES[name]}
            onClose={onClose}
            actions={
                <button type="button" className="kvm-btn primary" data-autofocus="" onClick={onClose}>
                    Close
                </button>
            }
        >
            <p className="kvm-dialog-note">This is not available in this build.</p>
        </ModalFrame>
    );
}

for (const name of DIALOG_NAMES) {
    registerDialog(name, name === "paste" ? PasteDialog : (props) => <UnavailableDialog name={name} {...props} />);
}
