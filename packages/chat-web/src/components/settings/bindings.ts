/**
 * Setting bindings: one shape for a value the settings UI can show and change, whether it comes from the
 * user's own view (`/api/settings`, keys relative to the user) or the admin view (`/api/admin/settings`,
 * full keys). Writes are optimistic: the query cache changes at once, rolls back on error, and is
 * refetched when the request settles.
 */
import { getDef, resolve, USERS_PREFIX, type SettingDef } from "@pikvm/chat-protocol";
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { translate } from "../../l10n/runtime";
import { api, ApiError } from "../../lib/api";
import { captureSessionEpoch, isSessionEpochCurrent, keys, settingsQuery } from "../../lib/queries";
import type { SettingView } from "../../lib/types";

/** Why a value cannot be changed here. */
export type Lock = "file" | "admin" | "policy";

export interface Binding<T = unknown> {
    key: string;
    value: T;
    /** True when this scope holds its own value (user override, or an admin row). */
    isSet: boolean;
    /** Value used when this scope has no own value. */
    inherited: T;
    writable: boolean;
    lock: Lock | null;
    loading: boolean;
    pending: boolean;
    error: string | null;
    set: (value: T) => void;
    /** Like `set`, but resolves when the server accepted the value and rejects with its error. */
    setAsync: (value: T) => Promise<void>;
    /** Remove this scope's own value. Undefined when there is nothing to remove or it is not allowed. */
    reset?: () => void;
}

export function errorText(e: unknown): string | null {
    if (!e) return null;
    if (e instanceof ApiError) {
        if (e.code === "managed_by_file") return translate("settings-error-managed-by-file");
        return e.message;
    }
    return e instanceof Error ? e.message : String(e);
}

const enc = encodeURIComponent;

type SettingChange = { value: unknown } | null;
interface SettingMutation {
    next: SettingChange;
    sessionEpoch: number;
}

const settingMutation = (next: SettingChange): SettingMutation => ({ next, sessionEpoch: captureSessionEpoch() });

function requireCurrentSession(sessionEpoch: number): void {
    if (!isSessionEpochCurrent(sessionEpoch))
        throw new Error("The account changed before this setting could be saved.");
}

// User view

type SettingsData = { settings: SettingView[]; free: { key: string; value: unknown }[] };

function patchView(v: SettingView, userValue: unknown): SettingView {
    const d = getDef(v.key);
    if (!d) return v;
    const r = resolve(d, v.globalValue, userValue);
    return {
        ...v,
        value: r.value,
        source: r.source,
        userValue,
        owners: r.owners ?? v.owners,
        shadowed: r.shadowed ?? v.shadowed,
    };
}

function userLock(v: SettingView | undefined): Lock | null {
    if (!v || v.writable) return null;
    if (v.managedByFile) return "file";
    return getDef(v.key)?.userTwin === "user" ? "policy" : "admin";
}

/** The current user's own setting `key` (relative to the user). */
export function useUserSetting<T>(key: string, fallback?: T): Binding<T> & { view?: SettingView } {
    const qc = useQueryClient();
    const { data, isLoading, error } = useQuery(settingsQuery);
    const view = data?.settings.find((s) => s.key === key);

    const mutation = useMutation({
        mutationFn: async ({ next, sessionEpoch }: SettingMutation) => {
            requireCurrentSession(sessionEpoch);
            await (next ? api.put(`/settings/${enc(key)}`, next) : api.del(`/settings/${enc(key)}`));
            requireCurrentSession(sessionEpoch);
        },
        onMutate: async ({ next, sessionEpoch }) => {
            requireCurrentSession(sessionEpoch);
            await qc.cancelQueries({ queryKey: keys.settings });
            requireCurrentSession(sessionEpoch);
            const prev = qc.getQueryData<SettingsData>(keys.settings);
            qc.setQueryData<SettingsData>(
                keys.settings,
                (d) =>
                    d && {
                        ...d,
                        settings: d.settings.map((s) =>
                            s.key === key ? patchView(s, next ? next.value : undefined) : s,
                        ),
                    },
            );
            return { prev, sessionEpoch };
        },
        onError: (_e, variables, ctx) => {
            if (isSessionEpochCurrent(variables.sessionEpoch) && ctx?.prev && isSessionEpochCurrent(ctx.sessionEpoch)) {
                qc.setQueryData(keys.settings, ctx.prev);
            }
        },
        onSettled: async (_data, _error, { sessionEpoch }) => {
            if (!isSessionEpochCurrent(sessionEpoch)) return;
            await Promise.all([
                qc.invalidateQueries({ queryKey: keys.settings }),
                // Model responses include the user's feature opt-outs.
                ...(key === "models.features" ? [qc.invalidateQueries({ queryKey: keys.models })] : []),
            ]);
        },
    });

    const def = getDef(key);
    const inherited = (view ? (view.globalValue ?? def?.default) : (fallback ?? def?.default)) as T;
    const value = (view?.value ?? fallback ?? def?.default) as T;
    const isSet = view?.source === "user";
    const writable = !!view?.writable && !mutation.isPending;
    return {
        key,
        view,
        value,
        inherited,
        isSet,
        writable,
        lock: userLock(view),
        loading: isLoading,
        pending: mutation.isPending,
        error: errorText(mutation.error ?? error),
        set: (v) => mutation.mutate(settingMutation({ value: v })),
        setAsync: async (v) => void (await mutation.mutateAsync(settingMutation({ value: v }))),
        reset: isSet && writable ? () => mutation.mutate(settingMutation(null)) : undefined,
    };
}

// Admin view

export interface AdminRow {
    key: string;
    value: unknown;
    source: "db" | "file";
    updatedAt: number;
    updatedBy: string | null;
}

export interface AdminDef {
    key: string;
    description: string;
    userTwin: "none" | "admin" | "user";
    merge: "override" | "record";
    default: unknown;
    value: unknown;
}

export interface AdminSettings {
    rows: AdminRow[];
    defs: AdminDef[];
}

export const adminSettingsKey = ["admin", "settings"] as const;

export const adminSettingsQuery = queryOptions({
    queryKey: adminSettingsKey,
    queryFn: () => api.get<AdminSettings>("/admin/settings"),
});

/** Base key of a full key: `users.<id>.policy.x` -> `policy.x`. */
export function baseKey(fullKey: string): string {
    const segs = fullKey.split(".");
    return segs[0] === USERS_PREFIX ? segs.slice(2).join(".") : fullKey;
}

export function invalidateAll(qc: QueryClient): void {
    void qc.invalidateQueries({ queryKey: adminSettingsKey });
    void qc.invalidateQueries({ queryKey: keys.settings });
    void qc.invalidateQueries({ queryKey: keys.bootstrap });
    void qc.invalidateQueries({ queryKey: keys.models });
}

/** Any full key, written through the admin API. Rows from config.toml are read-only. */
export function useAdminSetting<T>(fullKey: string): Binding<T> & { def?: SettingDef; row?: AdminRow } {
    const qc = useQueryClient();
    const { data, isLoading, error } = useQuery(adminSettingsQuery);
    const base = baseKey(fullKey);
    const def = getDef(base);
    const rows = data?.rows;
    const row = useMemo(() => rows?.find((r) => r.key === fullKey), [rows, fullKey]);
    const globalRow = useMemo(
        () => (base === fullKey ? undefined : rows?.find((r) => r.key === base)),
        [rows, base, fullKey],
    );

    const mutation = useMutation({
        mutationFn: async ({ next, sessionEpoch }: SettingMutation) => {
            requireCurrentSession(sessionEpoch);
            await (next
                ? api.put(`/admin/settings/${enc(fullKey)}`, next)
                : api.del(`/admin/settings/${enc(fullKey)}`));
            requireCurrentSession(sessionEpoch);
        },
        onMutate: async ({ next, sessionEpoch }) => {
            requireCurrentSession(sessionEpoch);
            await qc.cancelQueries({ queryKey: adminSettingsKey });
            requireCurrentSession(sessionEpoch);
            const prev = qc.getQueryData<AdminSettings>(adminSettingsKey);
            qc.setQueryData<AdminSettings>(adminSettingsKey, (d) => {
                if (!d) return d;
                const rest = d.rows.filter((r) => r.key !== fullKey);
                if (!next) return { ...d, rows: rest };
                const r: AdminRow = {
                    key: fullKey,
                    value: next.value,
                    source: "db",
                    updatedAt: Date.now(),
                    updatedBy: null,
                };
                return { ...d, rows: [...rest, r] };
            });
            return { prev, sessionEpoch };
        },
        onError: (_e, variables, ctx) => {
            if (isSessionEpochCurrent(variables.sessionEpoch) && ctx?.prev && isSessionEpochCurrent(ctx.sessionEpoch)) {
                qc.setQueryData(adminSettingsKey, ctx.prev);
            }
        },
        onSettled: (_data, _error, { sessionEpoch }) => {
            if (isSessionEpochCurrent(sessionEpoch)) invalidateAll(qc);
        },
    });

    const inherited = (base === fullKey ? def?.default : (globalRow?.value ?? def?.default)) as T;
    const fromFile = row?.source === "file";
    return {
        key: fullKey,
        def,
        row,
        value: (row ? row.value : inherited) as T,
        inherited,
        isSet: !!row,
        writable: !fromFile && !!data && !mutation.isPending,
        lock: fromFile ? "file" : null,
        loading: isLoading,
        pending: mutation.isPending,
        error: errorText(mutation.error ?? error),
        set: (v) => mutation.mutate(settingMutation({ value: v })),
        setAsync: async (v) => void (await mutation.mutateAsync(settingMutation({ value: v }))),
        reset: row && !fromFile && !mutation.isPending ? () => mutation.mutate(settingMutation(null)) : undefined,
    };
}

/** A binding for one field of an object-valued binding. Writes the whole object. */
export function fieldBinding<T extends object, K extends keyof T & string>(b: Binding<T>, field: K): Binding<T[K]> {
    const obj = (b.value ?? {}) as T;
    const inh = (b.inherited ?? {}) as T;
    return {
        ...b,
        key: `${b.key}.${field}`,
        value: obj[field],
        inherited: inh[field],
        set: (v) => b.set({ ...obj, [field]: v }),
        setAsync: (v) => b.setAsync({ ...obj, [field]: v }),
        reset: undefined,
    };
}

/** Widen a typed binding for the generic row renderer, which reads and writes `unknown`. */
export const erase = <T>(b: Binding<T>): Binding<unknown> => b as unknown as Binding<unknown>;
