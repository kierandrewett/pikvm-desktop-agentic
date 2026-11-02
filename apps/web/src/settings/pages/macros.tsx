/**
 * Settings -> Macros: the KVM screen's macro manager, drawn as this page's content. It is the
 * same component as the dialog (create, edit steps, icons, pin, reorder, delete, run), not a
 * second one, so what either does to the list the other sees.
 */

import "../../kvm/dialogs/dialogs.css";
import "../../kvm/kvm.css";
import { MacrosDialog } from "../../kvm/dialogs/macros-dialog";
import { Toast } from "../../kvm/overlays";
import { useAppKvmSession, useSessionReady } from "../../kvm/session";

const noop = (): void => {};

export function MacrosPage() {
    const session = useAppKvmSession();
    // Running a macro from here needs the link to the target, as it does on the KVM screen.
    useSessionReady(session);

    return (
        <>
            <MacrosDialog session={session} onClose={noop} presentation="page" />
            <Toast session={session} />
        </>
    );
}
