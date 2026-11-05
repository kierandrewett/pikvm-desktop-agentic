/** TanStack Query bindings for the app API. Request/response data only; sockets are not Query's. */

import type { Effect } from "effect";
import {
    type Macro,
    type PikvmAdd,
    type PikvmEntry,
    type PikvmList,
    type PikvmPatch,
    type ServerAdd,
    type ServerEntry,
    type ServerList,
    type ServerSignIn,
    type ServerSignInBegun,
    type ServerSignInStatus,
    type SessionView,
    type Settings,
    type SettingsPatch,
    type State,
} from "@pikvm/contracts/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    activatePikvm,
    addPikvm,
    addServer,
    ApiFailure,
    beginSignIn,
    cancelSignIn,
    signInStatus,
    getSession,
    getState,
    listMacros,
    listPikvms,
    listServers,
    patchSettings,
    removePikvm,
    removeServer,
    replaceMacros,
    runApi,
    setDefaultPikvm,
    switchServer,
    switchToThisComputer,
    updatePikvm,
} from "./client";

export const stateKey = ["state"] as const;
export const sessionKey = ["session"] as const;
export const macrosKey = ["macros"] as const;
export const pikvmsKey = ["pikvms"] as const;

export function useAppState() {
    return useQuery<State, ApiFailure>({
        queryKey: stateKey,
        queryFn: ({ signal }) => runApi(getState(), signal),
    });
}

/** Whether this host signs users in, and who is signed in. Read once; a sign-in does not change within a page. */
export function useSession() {
    return useQuery<SessionView, ApiFailure>({
        queryKey: sessionKey,
        queryFn: ({ signal }) => runApi(getSession(), signal),
        staleTime: Infinity,
    });
}

export function useMacros() {
    return useQuery({
        queryKey: macrosKey,
        queryFn: ({ signal }) => runApi(listMacros(), signal),
    });
}

/**
 * Replace the stored macro list. The cache takes the server's reply (it drops what it cannot
 * read), so the settings page and the KVM toolbar agree with what is stored.
 */
export function useSaveMacros() {
    const queryClient = useQueryClient();
    return useMutation<ReadonlyArray<Macro>, ApiFailure, ReadonlyArray<unknown>>({
        mutationFn: (macros) => runApi(replaceMacros(macros)),
        onSuccess: (stored) => {
            queryClient.setQueryData(macrosKey, stored);
        },
    });
}

/**
 * Save a settings change. The cached state takes the server's reply, not our guess, so
 * what a page shows after saving is what the server actually holds.
 */
export function useUpdateSettings() {
    const queryClient = useQueryClient();
    return useMutation<Settings, ApiFailure, SettingsPatch>({
        mutationFn: (patch) => runApi(patchSettings(patch)),
        onSuccess: (settings) => {
            queryClient.setQueryData<State>(stateKey, (previous) => (previous ? { ...previous, settings } : previous));
        },
    });
}

/** Every stored PiKVM, and whether this app may change them (false where the host pins its PiKVM). */
export function usePikvms() {
    return useQuery<PikvmList, ApiFailure>({
        queryKey: pikvmsKey,
        queryFn: ({ signal }) => runApi(listPikvms(), signal),
    });
}

/**
 * What every PiKVM write does afterwards. A reply that is the whole list goes straight into the cache; one that is
 * a single entry makes the list stale. Either way the app state is stale too: its link and address follow the
 * active PiKVM. No reply carries a password, so neither does the cache.
 */
function useAfterPikvmWrite() {
    const queryClient = useQueryClient();
    return (list?: PikvmList) => {
        if (list) queryClient.setQueryData(pikvmsKey, list);
        else void queryClient.invalidateQueries({ queryKey: pikvmsKey });
        void queryClient.invalidateQueries({ queryKey: stateKey });
    };
}

export function useAddPikvm() {
    const after = useAfterPikvmWrite();
    return useMutation<PikvmEntry, ApiFailure, PikvmAdd>({
        mutationFn: (payload) => runApi(addPikvm(payload)),
        onSuccess: () => after(),
    });
}

export function useUpdatePikvm() {
    const after = useAfterPikvmWrite();
    return useMutation<PikvmEntry, ApiFailure, { readonly id: string; readonly patch: PikvmPatch }>({
        mutationFn: ({ id, patch }) => runApi(updatePikvm(id, patch)),
        onSuccess: () => after(),
    });
}

export function useRemovePikvm() {
    const after = useAfterPikvmWrite();
    return useMutation<PikvmList, ApiFailure, string>({
        mutationFn: (id) => runApi(removePikvm(id)),
        onSuccess: after,
    });
}

/** The default is the one the app starts on; the active one is the one in use now. */
export function useSetDefaultPikvm() {
    const after = useAfterPikvmWrite();
    return useMutation<PikvmList, ApiFailure, string>({
        mutationFn: (id) => runApi(setDefaultPikvm(id)),
        onSuccess: after,
    });
}

export function useActivatePikvm() {
    const after = useAfterPikvmWrite();
    return useMutation<PikvmList, ApiFailure, string>({
        mutationFn: (id) => runApi(activatePikvm(id)),
        onSuccess: after,
    });
}

export const serversKey = ["servers"] as const;

/** The servers this app can use. This computer is not in the list; `localActive` says whether it is in use. */
export function useServers() {
    return useQuery<ServerList, ApiFailure>({
        queryKey: serversKey,
        queryFn: ({ signal }) => runApi(listServers(), signal),
    });
}

/** Adding does not switch servers, so only the list changes. */
export function useAddServer() {
    const queryClient = useQueryClient();
    return useMutation<ServerEntry, ApiFailure, ServerAdd>({
        mutationFn: (payload) => runApi(addServer(payload)),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: serversKey });
        },
    });
}

/** Every server write answers with the new list. The server in use may have changed, so all data is stale. */
function useServerWrite<V>(call: (variables: V) => Effect.Effect<ServerList, ApiFailure>) {
    const queryClient = useQueryClient();
    return useMutation<ServerList, ApiFailure, V>({
        mutationFn: (variables) => runApi(call(variables)),
        onSuccess: (list) => {
            queryClient.setQueryData(serversKey, list);
            void queryClient.invalidateQueries();
        },
    });
}

export const useRemoveServer = () => useServerWrite<string>(removeServer);
export const useUseServer = () => useServerWrite<string>(switchServer);
export const useUseLocalServer = () => useServerWrite<void>(() => switchToThisComputer());

/** Starts a browser sign-in. The caller opens the address it answers and then follows `useSignInStatus`. */
export function useBeginSignIn() {
    return useMutation<ServerSignInBegun, ApiFailure, ServerSignIn>({
        mutationFn: (payload) => runApi(beginSignIn(payload)),
    });
}

export function useCancelSignIn() {
    return useMutation<{ readonly ok: boolean }, ApiFailure, string>({
        mutationFn: (id) => runApi(cancelSignIn(id)),
    });
}

/** Asks how a browser sign-in is going once a second, until it is done or failed. Saving a server makes the list stale. */
export function useSignInStatus(id: string | undefined) {
    const queryClient = useQueryClient();
    return useQuery<ServerSignInStatus, ApiFailure>({
        queryKey: ["server-sign-in", id],
        enabled: id !== undefined,
        refetchInterval: (query) => (query.state.data && query.state.data.state !== "waiting" ? false : 1000),
        queryFn: async ({ signal }) => {
            const status = await runApi(signInStatus(id as string), signal);
            if (status.state === "done") void queryClient.invalidateQueries({ queryKey: serversKey });
            return status;
        },
    });
}
