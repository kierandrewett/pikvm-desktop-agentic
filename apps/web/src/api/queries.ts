/** TanStack Query bindings for the app API. Request/response data only; sockets are not Query's. */

import { type Settings, type SettingsPatch, type State } from "@pikvm/contracts/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiFailure, getState, listMacros, patchSettings, runApi } from "./client";
import { OAUTH_USERINFO_PATH } from "../host/paths";

export const stateKey = ["state"] as const;
export const macrosKey = ["macros"] as const;
export const accountKey = ["account"] as const;

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
