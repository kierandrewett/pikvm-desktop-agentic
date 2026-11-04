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
import { OAUTH_USERINFO_PATH } from "../host/paths";

export const stateKey = ["state"] as const;
export const macrosKey = ["macros"] as const;
export const accountKey = ["account"] as const;
export const pikvmsKey = ["pikvms"] as const;

export function useAppState() {
    return useQuery<State, ApiFailure>({
        queryKey: stateKey,
        queryFn: ({ signal }) => runApi(getState(), signal),
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

/**
 * Whether the host sits behind oauth2-proxy, found with a HEAD to its userinfo endpoint.
 * A host without the proxy answers 404 (kvmd) or something that is not JSON, and the
 * Account page then does not exist. Redirects are not followed: a sign-in redirect means
 * there is no session to sign out of.
 */
export async function detectProxySession(signal?: AbortSignal): Promise<boolean> {
    try {
        const reply = await fetch(OAUTH_USERINFO_PATH, { method: "HEAD", redirect: "manual", credentials: "same-origin", ...(signal ? { signal } : {}) });
        if (!reply.ok) return false;
        return !(reply.headers.get("content-type") ?? "").includes("text/html");
    } catch {
        return false;
    }
}

export function useProxySession() {
    return useQuery({
        queryKey: accountKey,
        queryFn: ({ signal }) => detectProxySession(signal),
        staleTime: 5 * 60_000,
        retry: false,
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
