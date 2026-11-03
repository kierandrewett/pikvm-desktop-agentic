/**
 * Shared parts of the model provider and MCP server pages.
 *
 * Both pages are guided flows inside one settings section, with the view held in search params:
 *   (none)            list of what is connected
 *   ?add=catalog      the catalogue
 *   ?add=<presetId>   setup page for one preset (or "custom")
 *   ?id=<entryId>     detail page for one entry
 * Writes go to the user value (`/api/settings/<key>`) or the global value (`/api/admin/settings/<key>`),
 * always as the whole map so other entries are kept. Masked secrets ("********") are sent back unchanged.
 */
import type { CatalogInput, McpCatalogInput } from "@pikvm/chat-protocol";
import { ArrowSquareOut, CheckCircle, Copy, WarningCircle } from "@pikvm/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "../../../nav";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SECRET_MASK } from "@pikvm/chat-protocol";
import { cn } from "../../../lib/cn";
import { useT } from "../../../l10n/provider";
import { keys, settingsQuery } from "../../../lib/queries";
import { useUserSetting, type Lock } from "../bindings";
import { Button, fieldClass, SettingRow, SettingsCard, secondaryText, Spinner, useSearchScope } from "../kit";

export type Owner = "user" | "global";

export interface RecordEntry<E> {
    id: string;
    entry: E;
    owner: Owner;
    /** A user entry hidden by an administrator entry with the same id. */
    shadowed: boolean;
    editable: boolean;
}

export interface Records<E> {
    entries: RecordEntry<E>[];
    get: (id: string) => RecordEntry<E> | undefined;
    writable: boolean;
    lock: Lock | null;
    loading: boolean;
    /** Write one entry; resolves when the server accepted it. */
    save: (id: string, entry: E) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

type Rec<E> = Record<string, E>;

/** Entries of a `record` setting. The administrator's entries are listed too, read-only. */
export function useRecords<E>(key: "agent.providers"): Records<E> {
    const qc = useQueryClient();
    // Settings can be restored from the offline cache and count as fresh for 30 s. These pages show policy locks
    // and other people's entries, so they always ask the server once when they open.
    useQuery({ ...settingsQuery, refetchOnMount: "always" });
    const b = useUserSetting<Rec<E>>(key);
    const view = b.view;
    const own = (view?.userValue ?? {}) as Rec<E>;
    const global = (view?.globalValue ?? {}) as Rec<E>;
    const shadowed = view?.shadowed;

    const entries = useMemo<RecordEntry<E>[]>(
        () => [
            ...Object.entries(own).map(([id, entry]) => ({
                id,
                entry,
                owner: "user" as const,
                shadowed: !!shadowed?.includes(id),
                editable: b.writable,
            })),
            ...Object.entries(global).map(([id, entry]) => ({
                id,
                entry,
                owner: "global" as const,
                shadowed: false,
                editable: false,
            })),
        ],
        // `own` and `global` are new objects per render; their JSON is the stable identity.
        [JSON.stringify(own), JSON.stringify(global), shadowed, b.writable],
    );

    const after = () => void qc.invalidateQueries({ queryKey: keys.models });
    return {
        entries,
        get: (id) => entries.find((e) => e.id === id && e.owner === "user") ?? entries.find((e) => e.id === id),
        writable: b.writable,
        lock: b.lock,
        loading: b.loading,
        save: async (id, entry) => {
            await b.setAsync({ ...own, [id]: entry });
            after();
        },
        remove: async (id) => {
            await b.setAsync(Object.fromEntries(Object.entries(own).filter(([k]) => k !== id)));
            after();
        },
    };
}

export interface SubView {
    add?: string;
    id?: string;
    go: (next: { add?: string; id?: string }) => void;
}

/** The section's current view, from the pane's search params (`?add=<preset>`, `?id=<entry>`). */
export function useSubView(): SubView {
    const search = useSearch() as { add?: unknown; id?: unknown };
    const navigate = useNavigate();
    return {
        add: search.add === undefined ? undefined : String(search.add),
        id: search.id === undefined ? undefined : String(search.id),
        go: (next) => void navigate({ to: ".", search: next as never }),
    };
}

/**
 * A detail page whose entry is missing asks the server once before saying so: the settings shown first can be a
 * cached snapshot from before the entry was saved. True while that check runs (or settings are still loading).
 */
export function useConfirmMissing(missing: boolean, loading: boolean): boolean {
    const qc = useQueryClient();
    const [state, setState] = useState<"idle" | "checking" | "done">("idle");
    useEffect(() => {
        if (!missing || loading || state !== "idle") return;
        setState("checking");
        void qc.refetchQueries({ queryKey: keys.settings }).finally(() => setState("done"));
    }, [missing, loading, state, qc]);
    return loading || (missing && state !== "done");
}

/** A unique record id from a name: lower case, letters, digits and dashes. */
export function makeId(name: string, taken: string[]): string {
    const base =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "custom";
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
    return id;
}

export const isMasked = (v: string | undefined) => v === SECRET_MASK;

/** One catalogue input as a stacked row: label, help, "Get a key" link and the field. */
export function InputRow({
    input,
    value,
    onChange,
    onBlur,
    error,
}: {
    input: CatalogInput | McpCatalogInput;
    value: string;
    onChange: (v: string) => void;
    onBlur?: () => void;
    error?: string | null;
}) {
    const t = useT();
    const id = `in-${input.label.replace(/\W+/g, "-")}`;
    const link = input.url && (
        <a
            href={input.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-sm text-accent-text hover-device:hover:underline pointer-coarse:min-h-10"
        >
            {input.target.kind === "apiKey" ? t("integrations-input-get-key") : t("integrations-input-find-it")}
            <ArrowSquareOut className="size-3.5" aria-hidden />
        </a>
    );
    return (
        <SettingRow
            stack
            label={
                <span className="flex items-center justify-between gap-3">
                    <label htmlFor={id}>
                        {input.label}
                        {input.optional && (
                            <span className="font-normal text-tertiary"> {t("integrations-input-optional")}</span>
                        )}
                    </label>
                    {link}
                </span>
            }
            description={input.help}
            error={error}
            control={
                <input
                    id={id}
                    type={input.secret ? "password" : "text"}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    inputMode={input.target.kind === "baseUrl" ? "url" : undefined}
                    value={value}
                    placeholder={input.defaultValue}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={onBlur}
                    className={cn(
                        fieldClass("md"),
                        (input.secret || input.target.kind === "baseUrl") && "w-full font-mono text-sm",
                    )}
                />
            }
        />
    );
}

export type Check =
    | { state: "idle" }
    | { state: "running"; text: string }
    | { state: "ok"; title: string; items?: string[]; itemsLabel?: string; latencyMs?: number }
    | { state: "error"; title: string; fix?: string; detail?: string; latencyMs?: number };

/** Seconds since `running` turned true, ticking once a second; 0 while idle. */
export function useElapsed(running: boolean): number {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!running) return setSeconds(0);
        const started = Date.now();
        const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(id);
    }, [running]);
    return seconds;
}

const SLOW_AFTER_S = 5;

/** Live connection feedback: spinner, success with what was found, or a plain error with the fix. */
export function CheckCard({ check }: { check: Check }) {
    const t = useT();
    const elapsed = useElapsed(check.state === "running");
    if (check.state === "idle") return null;
    return (
        <SettingsCard>
            <div role={check.state === "error" ? "alert" : "status"} className="flex gap-3 px-4 py-3">
                <span className="pt-px">
                    {check.state === "running" && <Spinner className="text-text" />}
                    {check.state === "ok" && <CheckCircle weight="fill" className="size-4 text-success" aria-hidden />}
                    {check.state === "error" && (
                        <WarningCircle weight="fill" className="size-4 text-danger" aria-hidden />
                    )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm leading-[18.5714px] font-medium">
                        {check.state === "running" ? check.text : check.title}
                        {check.state === "running" && elapsed > 0 && (
                            <span className="text-xs font-normal text-tertiary tabular-nums">
                                {t("integrations-seconds", { value: elapsed })}
                            </span>
                        )}
                        {check.state !== "running" && !!check.latencyMs && (
                            <span className="text-xs font-normal text-tertiary tabular-nums">
                                {check.latencyMs < 1000
                                    ? t("integrations-latency-ms", { value: check.latencyMs })
                                    : t("integrations-latency-s", { value: check.latencyMs / 1000 })}
                            </span>
                        )}
                    </div>
                    {check.state === "running" && elapsed >= SLOW_AFTER_S && (
                        <div className={cn("text-xs leading-4", secondaryText)}>{t("integrations-check-slow")}</div>
                    )}
                    {check.state === "error" && check.fix && (
                        <div className={cn("text-xs leading-4", secondaryText)}>{check.fix}</div>
                    )}
                    {check.state === "error" && check.detail && (
                        <div className="mt-1 font-mono text-xs leading-4 break-words text-tertiary">{check.detail}</div>
                    )}
                    {check.state === "ok" && !!check.items?.length && (
                        <ItemChips items={check.items} label={check.itemsLabel ?? t("integrations-check-found")} />
                    )}
                </div>
            </div>
        </SettingsCard>
    );
}

function ItemChips({ items, label }: { items: string[]; label: string }) {
    const t = useT();
    const [all, setAll] = useState(false);
    const shown = all ? items : items.slice(0, 12);
    return (
        <ul aria-label={label} className="mt-1 flex flex-wrap gap-1.5">
            {shown.map((m) => (
                <li
                    key={m}
                    className="inline-flex h-6 max-w-full items-center rounded-full bg-soft px-2 font-mono text-xs"
                >
                    <span className="truncate">{m}</span>
                </li>
            ))}
            {items.length > shown.length && (
                <li>
                    <button
                        type="button"
                        onClick={() => setAll(true)}
                        className="inline-flex h-6 items-center rounded-full px-2 text-xs text-accent-text"
                    >
                        {t("integrations-items-more", { count: items.length - shown.length })}
                    </button>
                </li>
            )}
        </ul>
    );
}

/** Read-only JSON of an entry for experts. Secrets stay masked. */
export function JsonBlock({ value }: { value: unknown }) {
    const t = useT();
    const text = JSON.stringify(value, null, 2);
    const [copied, setCopied] = useState(false);
    return (
        <div className="relative">
            <pre className="max-h-80 overflow-auto rounded-2xl border border-default bg-code p-4 font-mono text-xs leading-5">
                {text}
            </pre>
            <div className="absolute top-2 end-2">
                <Button onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
                    <Copy /> {copied ? t("integrations-copied") : t("integrations-copy")}
                </Button>
            </div>
        </div>
    );
}

/** Search box for long model and tool lists. */
export function ListSearch({
    value,
    onChange,
    label,
}: {
    value: string;
    onChange: (v: string) => void;
    label: string;
}) {
    const t = useT();
    return (
        <input
            type="search"
            aria-label={label}
            placeholder={t("integrations-search")}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(fieldClass("sm"), "w-44 max-sm:w-32")}
        />
    );
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
