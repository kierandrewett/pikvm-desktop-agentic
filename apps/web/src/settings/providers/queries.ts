/** TanStack Query bindings for the harness's provider endpoints. Secrets never pass through here. */

import { useQuery } from "@tanstack/react-query";
import {
    type Attempt,
    type CatalogEntry,
    type CliStatus,
    type KeyEntry,
    type ModelCatalog,
    type ProviderHealth,
    HarnessError,
    getAttempt,
    getModelCatalog,
    getProviderCatalog,
    isActive,
    listCliAuth,
    listProviderKeys,
    listProviders,
} from "./harness-api";

export const harnessKeys = {
    providers: ["harness", "providers"] as const,
    keys: ["harness", "provider-keys"] as const,
    cli: ["harness", "cli-auth"] as const,
    catalog: ["harness", "provider-catalog"] as const,
    models: ["harness", "model-catalog"] as const,
    attempt: (cli: string) => ["harness", "cli-attempt", cli] as const,
};

/** How often a running sign-in is polled. Short in tests so they do not wait on real seconds. */
export const SIGN_IN_POLL_MS = import.meta.env.MODE === "test" ? 25 : 1500;

export function useProviders() {
    return useQuery<Record<string, ProviderHealth>, HarnessError>({
        queryKey: harnessKeys.providers,
        queryFn: ({ signal }) => listProviders(signal),
        retry: false,
    });
}

export function useProviderKeys(enabled: boolean) {
    return useQuery<KeyEntry[], HarnessError>({
        queryKey: harnessKeys.keys,
        queryFn: ({ signal }) => listProviderKeys(signal),
        enabled,
        retry: false,
    });
}

export function useCliAuth(enabled: boolean) {
    return useQuery<CliStatus[], HarnessError>({
        queryKey: harnessKeys.cli,
        queryFn: ({ signal }) => listCliAuth(signal),
        enabled,
        retry: false,
    });
}

export function useProviderCatalog(enabled: boolean) {
    return useQuery<CatalogEntry[], HarnessError>({
        queryKey: harnessKeys.catalog,
        queryFn: ({ signal }) => getProviderCatalog(signal),
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });
}

export function useModelCatalog(enabled: boolean) {
    return useQuery<ModelCatalog, HarnessError>({
        queryKey: harnessKeys.models,
        queryFn: ({ signal }) => getModelCatalog(signal),
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });
}

/** The running sign-in for one CLI, polled while it is active and quiet once it ends. */
export function useCliAttempt(cli: string, enabled: boolean) {
    return useQuery<Attempt, HarnessError>({
        queryKey: harnessKeys.attempt(cli),
        queryFn: ({ signal }) => getAttempt(cli, signal),
        enabled,
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (isActive(query.state.data) ? SIGN_IN_POLL_MS : false),
    });
}
