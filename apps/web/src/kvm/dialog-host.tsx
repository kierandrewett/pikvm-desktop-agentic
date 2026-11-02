/**
 * Renders whichever dialog is open. The components come from the registry in dialog-seam.ts:
 * the defaults first, then the dialogs module if it exists in this build.
 */

import "./dialog-defaults";
import type { KvmSession } from "./session";
import { dialogFor } from "./dialog-seam";
import { useStore } from "./use-store";

// The dialogs module registers itself over the defaults. Found by glob, not imported by name,
// so this file does not care whether it exists yet.
const modules = import.meta.glob<{ registerKvmDialogs?: () => void }>("./dialogs/index.ts", { eager: true });
for (const module of Object.values(modules)) module.registerKvmDialogs?.();

export function DialogHost({ session }: { session: KvmSession }) {
    const { open } = useStore(session.dialogs.store);
    if (!open) return null;
    const Dialog = dialogFor(open);
    if (!Dialog) return null;
    return <Dialog session={session} onClose={session.dialogs.close} />;
}
