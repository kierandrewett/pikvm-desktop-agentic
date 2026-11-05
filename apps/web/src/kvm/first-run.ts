/**
 * First run: the app has no PiKVM to connect to yet.
 *
 * That is only true when the host lets the app keep its own PiKVMs, none is saved and no server is in use. A host that
 * pins its PiKVM, a server in use (it keeps its own list) and a list that has not loaded, or failed to, are all
 * something else: the welcome must never stand in for a picture that could be, or for an error that should be shown.
 */

import type { ServerEntry } from "@pikvm/contracts/api";
import { type SignalState, STATUS, type StatusTone, statusLabel } from "@pikvm/kvm-engine";
import { createContext, useContext } from "react";
import { usePikvms, useServers } from "../api/queries";

export type FirstRun =
    | { readonly phase: "loading" }
    | { readonly phase: "failed"; readonly message: string; readonly retry: () => void }
    /** `saved`: a server that is saved but not in use, for the server form to offer. */
    | { readonly phase: "needed"; readonly saved: ServerEntry | undefined }
    | { readonly phase: "done" };

export function useFirstRun(): FirstRun {
    const pikvms = usePikvms();
    const servers = useServers();

    const failure = pikvms.error ?? servers.error;
    if (failure) {
        return {
            phase: "failed",
            message: failure.message,
            retry: () => {
                void pikvms.refetch();
                void servers.refetch();
            },
        };
    }
    if (!pikvms.data || !servers.data) return { phase: "loading" };

    const editable = pikvms.data.editable && servers.data.editable;
    if (editable && pikvms.data.items.length === 0 && servers.data.localActive) {
        return { phase: "needed", saved: servers.data.items[0] };
    }
    return { phase: "done" };
}

/** Whether the screen is the first-run welcome. Set once, by the screen, for the status chip in the bar. */
const FirstRunContext = createContext(false);

export const FirstRunProvider = FirstRunContext.Provider;

const NO_PIKVM: { readonly tone: StatusTone; readonly label: string } = { tone: "", label: "No PiKVM yet" };

/** The status chip in the toolbar and the dock. With no PiKVM there is no stream, so it says that and nothing red. */
export function useStatusChip(signal: SignalState, inputOpen: boolean): { readonly tone: StatusTone; readonly label: string } {
    const firstRun = useContext(FirstRunContext);
    if (firstRun) return NO_PIKVM;
    return { tone: STATUS[signal].tone, label: statusLabel(signal, inputOpen) };
}
