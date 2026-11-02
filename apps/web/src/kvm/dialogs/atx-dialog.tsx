/**
 * ATX power: the confirmation each of the three buttons asks before pressing anything (the
 * console used window.confirm). The same press is reused by the System dialog's power section.
 */

import { useState } from "react";
import type { DialogProps } from "../dialog-seam";
import type { KvmSession } from "../session";
import { useTarget } from "../session";
import { kvmdPost } from "./kvmd";
import { ATX_COPY, atxView, type AtxButton } from "./model/health";
import { Btn, DialogShell, Note } from "./shell";

/**
 * Press an ATX button. Resolves with the error to show, or null when kvmd took it.
 * 409 is kvmd serialising ATX across clients.
 */
export async function pressAtx(session: KvmSession, button: AtxButton): Promise<string | null> {
    const result = await kvmdPost(session, `/api/atx/click?button=${encodeURIComponent(button)}`);
    if (result.ok) {
        session.notices.notify({ text: `${ATX_COPY[button].label} pressed` });
        return null;
    }
    if (result.status === 409) return "Another client is using the power controls. Try again in a moment.";
    return result.status !== null ? `Power action failed (${result.status})` : `Power action failed: ${result.message}`;
}

export function AtxDialog({ session, onClose, button }: DialogProps & { button: AtxButton }) {
    const copy = ATX_COPY[button];
    const view = atxView(useTarget((s) => s.device.atx));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const confirm = async (): Promise<void> => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const failure = await pressAtx(session, button);
        // The dialog may have been dismissed while the request ran; closing again would close whatever is open now.
        if (failure === null) {
            if (session.dialogs.store.getState().open === dialogNameFor(button)) onClose();
            return;
        }
        setError(failure);
        setBusy(false);
    };

    return (
        <DialogShell
            title={copy.title}
            onClose={onClose}
            role="alertdialog"
            initialFocus="[data-cancel]"
            testId={`atx-${button}`}
            actions={
                <>
                    <Btn data-cancel="" onClick={onClose}>
                        Cancel
                    </Btn>
                    <Btn variant="danger" disabled={busy || view.busy || !view.available} onClick={() => void confirm()}>
                        {copy.confirm}
                    </Btn>
                </>
            }
        >
            <p className="dlg-confirm-body">{copy.body}</p>
            {view.available ? (
                <p className="dlg-note" aria-live="polite">
                    {view.text}
                </p>
            ) : (
                <Note warn>This PiKVM has no ATX power wiring.</Note>
            )}
            {error ? (
                <p className="dlg-note is-warn" role="alert">
                    {error}
                </p>
            ) : null}
        </DialogShell>
    );
}

export function dialogNameFor(button: AtxButton): "atx-power" | "atx-power-long" | "atx-reset" {
    return button === "power" ? "atx-power" : button === "power_long" ? "atx-power-long" : "atx-reset";
}

export const AtxPowerDialog = (props: DialogProps) => <AtxDialog {...props} button="power" />;
export const AtxPowerLongDialog = (props: DialogProps) => <AtxDialog {...props} button="power_long" />;
export const AtxResetDialog = (props: DialogProps) => <AtxDialog {...props} button="reset" />;
