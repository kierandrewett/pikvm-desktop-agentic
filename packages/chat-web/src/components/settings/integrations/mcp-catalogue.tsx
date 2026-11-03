/**
 * MCP catalogue, sign-in (OAuth) and server detail extras.
 *
 * The catalogue lists GET /api/mcp/catalog entries in a Connected strip, a Featured section and one section per
 * category. Sign-in runs on the Chat server: POST /api/mcp/servers/:id/connect returns an address that opens in a
 * popup. The popup ends on /settings/mcp?oauth=... and tells this window through the BroadcastChannel below.
 * Tokens never reach the browser.
 */
import {
    mcpCategories,
    type McpCatalogItem,
    type McpCatalogResponse,
    type McpConnection,
    type McpDiscovery,
    type McpInventory,
    type McpPreset,
    type McpToolHints,
} from "@pikvm/chat-protocol";
import { Check, Copy, Lock, MagnifyingGlass, Plus, WarningCircle } from "@pikvm/icons";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { msg, translate } from "../../../l10n/runtime";
import { useLocale, useT } from "../../../l10n/provider";
import { ConfirmDialog } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { errorMessage, type RecordEntry } from "./common";
import { HealthLine, useAgo, type Health } from "./parts";
import { Badge, Button, fieldClass, IconTile, Notice, SettingRow, SettingsCard, SettingsSection } from "../kit";

export const mcpCatalogQuery = queryOptions({
    queryKey: ["catalog", "mcp"],
    queryFn: () => api.get<McpCatalogResponse>("/mcp/catalog"),
    staleTime: 10 * 60_000,
});

export const mcpConnectionsQuery = queryOptions({
    queryKey: ["mcp", "connections"],
    queryFn: async () => (await api.get<{ connections: McpConnection[] }>("/mcp/connections")).connections,
    staleTime: 30_000,
});

export const mcpInventoryQuery = (id: string) =>
    queryOptions({
        queryKey: ["mcp", "inventory", id],
        queryFn: () => api.get<McpInventory>(`/mcp/servers/${encodeURIComponent(id)}/inventory`),
        staleTime: 60_000,
        retry: false,
    });

const CHANNEL = "chat-mcp-oauth";

interface OAuthMessage {
    result: "connected" | "error";
    id?: string;
    message?: string;
}

/** Logo from the Chat server, or a letter when the entry has none or the image fails. */
export function McpLogo({ src, name, size = "md" }: { src?: string; name: string; size?: "md" | "lg" }) {
    const [broken, setBroken] = useState(!src);
    return (
        <IconTile size={size}>
            {broken || !src ? (
                <span aria-hidden className="text-sm font-semibold uppercase">
                    {name.trim().charAt(0) || "?"}
                </span>
            ) : (
                <img
                    src={src}
                    alt=""
                    width={20}
                    height={20}
                    loading="lazy"
                    onError={() => setBroken(true)}
                    className="size-5 object-contain"
                />
            )}
        </IconTile>
    );
}

// Sign-in

/** Listen for the sign-in popup; refresh what depends on the connection and tell the user. */
export function useOAuthListener(): void {
    const qc = useQueryClient();
    useEffect(() => {
        if (typeof BroadcastChannel === "undefined") return;
        const channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (ev: MessageEvent<OAuthMessage>) => {
            const m = ev.data;
            void qc.invalidateQueries({ queryKey: mcpConnectionsQuery.queryKey });
            if (m.id) void qc.invalidateQueries({ queryKey: ["mcp", "inventory", m.id] });
            void qc.invalidateQueries({ queryKey: ["mcp"] });
            if (m.result === "connected") toast.success(translate("integrations-mcp-connected"), { id: "mcp-oauth" });
            else
                toast.error(translate("integrations-mcp-signin-unfinished"), {
                    id: "mcp-oauth",
                    description: m.message,
                });
        };
        return () => channel.close();
    }, [qc]);
}

/**
 * The page the sign-in popup lands on. In a popup it reports on the channel and closes. Without a popup it shows
 * the result and removes the oauth parameters from the address.
 */
export function useOAuthReturn(): { result: OAuthMessage | null; dismiss: () => void } {
    const search = useSearch({ strict: false }) as { oauth?: unknown; id?: unknown; message?: unknown };
    const [result, setResult] = useState<OAuthMessage | null>(null);
    const handled = useRef(false);
    const oauth = search.oauth === "connected" || search.oauth === "error" ? search.oauth : undefined;
    useEffect(() => {
        if (!oauth || handled.current) return;
        handled.current = true;
        const message: OAuthMessage = {
            result: oauth,
            id: search.id === undefined ? undefined : String(search.id),
            message: search.message === undefined ? undefined : String(search.message),
        };
        if (window.opener && typeof BroadcastChannel !== "undefined") {
            const channel = new BroadcastChannel(CHANNEL);
            channel.postMessage(message);
            channel.close();
            window.close();
        }
        setResult(message);
        const url = new URL(window.location.href);
        for (const key of ["oauth", "code", "message"]) url.searchParams.delete(key);
        window.history.replaceState(window.history.state, "", url);
    }, [oauth, search.id, search.message]);
    return { result, dismiss: () => setResult(null) };
}

/** Start the sign-in for one server. Opens a popup, or this window when the browser blocks popups. */
export function useConnect() {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const connect = async (id: string) => {
        setBusy(id);
        setError(null);
        // Open the window first: browsers only allow a popup that a click opens directly.
        const popup = window.open("about:blank", "chat-mcp-oauth", "popup=yes,width=520,height=720");
        try {
            const { url } = await api.post<{ url: string }>(`/mcp/servers/${encodeURIComponent(id)}/connect`, {});
            if (popup && !popup.closed) popup.location.href = url;
            else window.location.assign(url);
        } catch (err) {
            popup?.close();
            setError(errorMessage(err));
        } finally {
            setBusy(null);
        }
    };
    return { connect, busy, error };
}

// Status

export function connectionHealth(c: McpConnection | undefined): Health {
    if (!c) return { tone: "warning", text: translate("integrations-mcp-needs-signin") };
    if (c.status === "connected") return { tone: "ok", text: translate("integrations-mcp-connected") };
    if (c.status === "expired") return { tone: "warning", text: translate("integrations-mcp-needs-signin") };
    return { tone: "error", text: translate("integrations-mcp-needs-attention") };
}

// Catalogue

const CATEGORY_TITLE: Record<string, string> = {
    developer: msg("integrations-mcp-cat-developer"),
    productivity: msg("integrations-mcp-cat-productivity"),
    knowledge: msg("integrations-mcp-cat-knowledge"),
    data: msg("integrations-mcp-cat-data"),
    communication: msg("integrations-mcp-cat-communication"),
    design: msg("integrations-mcp-cat-design"),
    utilities: msg("integrations-mcp-cat-utilities"),
};

function CatalogueTile({
    item,
    added,
    health,
    onPick,
}: {
    item: McpCatalogItem;
    added: boolean;
    health?: Health;
    onPick: () => void;
}) {
    const t = useT();
    const locked = !item.allowed && !added;
    return (
        <button
            type="button"
            onClick={onPick}
            disabled={locked}
            data-preset={item.id}
            className="flex h-full min-h-16 w-full items-center gap-3 rounded-2xl border border-default bg-control px-3 py-2.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-ring enabled:hover-device:hover:bg-hover disabled:opacity-70"
        >
            <McpLogo src={item.logo} name={item.name} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{item.name}</span>
                <span className="line-clamp-2 text-xs text-tertiary">
                    {locked ? t("integrations-mcp-not-allowed") : item.tagline}
                </span>
            </span>
            <span className="shrink-0 text-xs text-secondary">
                {locked ? (
                    <span className="inline-flex items-center gap-1">
                        <Lock aria-hidden className="size-3.5" /> {t("integrations-mcp-locked")}
                    </span>
                ) : health ? (
                    <HealthLine health={health} />
                ) : added ? (
                    <span className="inline-flex items-center gap-1">
                        <Check aria-hidden className="size-3.5" /> {t("integrations-gallery-added")}
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-1">
                        <Plus aria-hidden className="size-3.5" /> {t("integrations-add")}
                    </span>
                )}
            </span>
        </button>
    );
}

function TileGrid({ title, children }: { title: string; children: ReactNode }) {
    return (
        <SettingsSection title={title}>
            <ul aria-label={title} className="grid gap-2 min-[720px]:grid-cols-2">
                {children}
            </ul>
        </SettingsSection>
    );
}

/** The catalogue sections. `entries` are the user's or administrator's `agent.mcp` records. */
export function McpCatalogue({
    entries,
    onOpen,
    onAdd,
    onCustom,
}: {
    entries: RecordEntry<unknown>[];
    onOpen: (id: string) => void;
    onAdd: (id: string) => void;
    onCustom: () => void;
}) {
    const t = useT();
    const cat = useQuery(mcpCatalogQuery);
    const conns = useQuery(mcpConnectionsQuery);
    const [query, setQuery] = useState("");
    const categoryTitle = (id: string) => (CATEGORY_TITLE[id] ? t(CATEGORY_TITLE[id]) : id);
    if (cat.isLoading)
        return (
            <div
                role="status"
                aria-label={t("integrations-mcp-catalogue-loading")}
                className="grid gap-2 min-[720px]:grid-cols-2"
            >
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-2xl bg-soft" />
                ))}
            </div>
        );
    if (cat.isError || !cat.data)
        return (
            <Notice
                tone="danger"
                action={
                    <Button busy={cat.isFetching} onClick={() => void cat.refetch()}>
                        {t("integrations-try-again")}
                    </Button>
                }
            >
                {t("integrations-prov-catalogue-failed", { error: errorMessage(cat.error) })}
            </Notice>
        );
    const { entries: items, featured, canAdd } = cat.data;
    const addedIds = new Set(entries.map((e) => e.id));
    const isAdded = (item: McpCatalogItem) => addedIds.has(item.id);
    const connection = (id: string) => conns.data?.find((c) => c.server === id);
    const q = query.trim().toLowerCase();
    const matches = (i: McpCatalogItem) =>
        !q || `${i.name} ${i.tagline} ${i.publisher} ${categoryTitle(i.category)}`.toLowerCase().includes(q);
    const shown = items.filter(matches);
    const healthOf = (item: McpCatalogItem): Health | undefined => {
        if (!isAdded(item)) return undefined;
        if (item.auth !== "oauth") return undefined;
        return connectionHealth(connection(item.id));
    };
    const tile = (item: McpCatalogItem) => (
        <li key={item.id} className="min-w-0">
            <CatalogueTile
                item={item}
                added={isAdded(item)}
                health={healthOf(item)}
                onPick={() => (isAdded(item) ? onOpen(item.id) : onAdd(item.id))}
            />
        </li>
    );
    const connected = shown.filter(isAdded);
    const featuredItems = !q ? featured.flatMap((id) => shown.filter((i) => i.id === id && !isAdded(i))) : [];
    const shownInFeatured = new Set(featuredItems.map((i) => i.id));
    const categories = mcpCategories
        .map((c) => ({
            id: c,
            items: shown.filter((i) => i.category === c && !isAdded(i) && !shownInFeatured.has(i.id)),
        }))
        .filter((g) => g.items.length > 0);
    return (
        <>
            <label className="relative block">
                <span className="sr-only">{t("integrations-mcp-search")}</span>
                <MagnifyingGlass
                    aria-hidden
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
                />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("integrations-mcp-search")}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(fieldClass("md"), "w-full ps-9")}
                    data-gallery-search
                />
            </label>
            {shown.length === 0 && (
                <p role="status" className="px-1 text-sm text-secondary">
                    {t("integrations-mcp-gallery-empty", { query: query.trim() })}
                </p>
            )}
            {connected.length > 0 && <TileGrid title={t("integrations-gallery-added")}>{connected.map(tile)}</TileGrid>}
            {featuredItems.length > 0 && (
                <TileGrid title={t("integrations-mcp-featured")}>{featuredItems.map(tile)}</TileGrid>
            )}
            {categories.map((g) => (
                <TileGrid key={g.id} title={categoryTitle(g.id)}>
                    {g.items.map(tile)}
                </TileGrid>
            ))}
            {canAdd && (
                <SettingsSection title={t("integrations-prov-something-else")}>
                    <ul aria-label={t("integrations-prov-something-else")} className="grid gap-2">
                        <li>
                            <button
                                type="button"
                                onClick={onCustom}
                                data-preset="custom"
                                className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-default bg-control px-3 py-2.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-ring hover-device:hover:bg-hover"
                            >
                                <IconTile>
                                    <Plus aria-hidden />
                                </IconTile>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium">{t("integrations-mcp-custom")}</span>
                                    <span className="text-xs text-tertiary">{t("integrations-mcp-custom-help")}</span>
                                </span>
                            </button>
                        </li>
                    </ul>
                </SettingsSection>
            )}
        </>
    );
}

// Discovery for the custom server flow

/** Probe a server address as the user types. One request per settled address. */
export function useDiscovery(url: string, scope: "user" | "global") {
    const [state, setState] = useState<
        | { status: "idle" }
        | { status: "running" }
        | { status: "done"; result: McpDiscovery }
        | { status: "failed"; message: string }
    >({ status: "idle" });
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        const v = url.trim();
        if (!/^https?:\/\/\S+$/i.test(v)) return setState({ status: "idle" });
        let live = true;
        setState({ status: "running" });
        const timer = window.setTimeout(() => {
            api.post<McpDiscovery>("/mcp/discover", { url: v, scope }).then(
                (result) => live && setState({ status: "done", result }),
                (err) => live && setState({ status: "failed", message: errorMessage(err) }),
            );
        }, 600);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [url, scope, nonce]);
    return { state, retry: () => setNonce((n) => n + 1) };
}

/** What discovery found: identity, or sign-in needed, or a plain error with Try again. */
export function DiscoveryCard({
    state,
    retry,
}: {
    state: ReturnType<typeof useDiscovery>["state"];
    retry: () => void;
}) {
    const t = useT();
    if (state.status === "idle") return null;
    if (state.status === "running")
        return (
            <Notice>
                <span role="status">{t("integrations-mcp-looking")}</span>
            </Notice>
        );
    const again = <Button onClick={retry}>{t("integrations-try-again")}</Button>;
    if (state.status === "failed")
        return (
            <Notice tone="danger" action={again}>
                {t("integrations-mcp-check-failed", { error: state.message })}
            </Notice>
        );
    const r = state.result;
    if (!r.ok)
        return (
            <Notice tone="danger" action={again}>
                {r.error ?? t("integrations-mcp-not-mcp")}
            </Notice>
        );
    const name = r.serverTitle ?? r.serverName ?? t("integrations-mcp-server-fallback");
    return (
        <SettingsCard>
            <SettingRow
                label={name}
                description={[
                    r.serverVersion && t("integrations-mcp-version", { version: r.serverVersion }),
                    r.era && (r.era === "stateless" ? t("integrations-mcp-stateless") : t("integrations-mcp-stateful")),
                    r.protocolVersion,
                    r.tools ? t("integrations-mcp-tools", { count: r.tools.length }) : undefined,
                ]
                    .filter(Boolean)
                    .join(" · ")}
                control={
                    r.auth === "oauth" ? (
                        <Badge tone="warning">{t("integrations-mcp-signin-needed")}</Badge>
                    ) : (
                        <Badge tone="success">{t("integrations-mcp-reachable")}</Badge>
                    )
                }
            />
        </SettingsCard>
    );
}

// Detail extras

function useExpiryText(): (ms: number | undefined) => string {
    const t = useT();
    const ago = useAgo();
    const { locale } = useLocale();
    return (ms) => {
        if (!ms) return t("integrations-mcp-expiry-unknown");
        if (ms < Date.now()) return t("integrations-mcp-expiry-ended", { when: ago(ms) ?? "" });
        const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(ms));
        return t("integrations-mcp-expiry-ends", { when });
    };
}

/** Sign-in state, account, scopes, and the Reconnect and Disconnect actions. */
export function ConnectionCard({ id, onDisconnect }: { id: string; onDisconnect: () => void }) {
    const t = useT();
    const ago = useAgo();
    const expiryText = useExpiryText();
    const conns = useQuery(mcpConnectionsQuery);
    const { connect, busy, error } = useConnect();
    const c = conns.data?.find((x) => x.server === id);
    const health = connectionHealth(c);
    const label = !c ? t("integrations-connect") : t("integrations-mcp-reconnect");
    return (
        <SettingsSection title={t("integrations-mcp-signin")}>
            {error && <Notice tone="danger">{error}</Notice>}
            {c?.status === "expired" && <Notice tone="warning">{t("integrations-mcp-signin-ended")}</Notice>}
            {c?.status === "needs_more_access" && (
                <Notice tone="warning">
                    {c.missingScopes?.length
                        ? t("integrations-mcp-more-access-scopes", { scopes: c.missingScopes.join(", ") })
                        : t("integrations-mcp-more-access")}
                </Notice>
            )}
            <SettingsCard>
                <SettingRow
                    label={t("integrations-status")}
                    description={<HealthLine health={health} />}
                    control={
                        <span className="flex flex-wrap items-center gap-2">
                            <Button
                                variant={c?.status === "connected" ? "secondary" : "primary"}
                                busy={busy === id}
                                onClick={() => void connect(id)}
                            >
                                {label}
                            </Button>
                            {c && (
                                <Button variant="danger" onClick={onDisconnect}>
                                    {t("integrations-mcp-disconnect")}
                                </Button>
                            )}
                        </span>
                    }
                />
                {c?.account && (
                    <SettingRow
                        label={t("integrations-mcp-account")}
                        control={<span className="text-sm">{c.account}</span>}
                    />
                )}
                {c && (
                    <SettingRow
                        label={t("integrations-mcp-access-granted")}
                        description={c.scopes.length ? undefined : t("integrations-mcp-no-scopes")}
                        control={
                            c.scopes.length > 0 ? (
                                <span className="flex flex-wrap justify-end gap-1">
                                    {c.scopes.map((s) => (
                                        <Badge key={s}>{s}</Badge>
                                    ))}
                                </span>
                            ) : undefined
                        }
                    />
                )}
                {c && (
                    <SettingRow
                        label={t("integrations-mcp-signin")}
                        control={<span className="text-sm text-secondary">{expiryText(c.expiresAt)}</span>}
                    />
                )}
                {c && (
                    <SettingRow
                        label={t("integrations-mcp-signed-in")}
                        control={<span className="text-sm text-secondary">{ago(c.connectedAt)}</span>}
                    />
                )}
            </SettingsCard>
            <p className="px-1 text-xs text-tertiary">{t("integrations-mcp-tokens-note")}</p>
        </SettingsSection>
    );
}

export async function disconnectServer(id: string): Promise<void> {
    await api.del(`/mcp/servers/${encodeURIComponent(id)}/connection`);
}

export const toolBadges = (t: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
}) => <ToolBadgeList {...t} />;

function ToolBadgeList(h: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }) {
    const t = useT();
    return (
        <span className="flex flex-wrap items-center gap-1">
            {h.readOnly && <Badge>{t("integrations-mcp-badge-read-only")}</Badge>}
            {h.destructive && <Badge tone="warning">{t("integrations-mcp-badge-destructive")}</Badge>}
            {h.idempotent && <Badge>{t("integrations-mcp-badge-idempotent")}</Badge>}
            {h.openWorld && <Badge>{t("integrations-mcp-badge-open-world")}</Badge>}
        </span>
    );
}

/** Prompts, resources, permissions and information for one server, from its inventory. */
export function InventorySections({
    id,
    inventory,
    rows,
}: {
    id: string;
    inventory: McpInventory | undefined;
    /** Information table rows the caller knows: publisher, address, website and so on. */
    rows: { label: string; value: ReactNode }[];
}) {
    const t = useT();
    const conns = useQuery(mcpConnectionsQuery);
    const c = conns.data?.find((x) => x.server === id);
    const [preview, setPreview] = useState<{ uri: string; text: string } | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const open = async (uri: string) => {
        setPreviewError(null);
        try {
            const r = await api.get<{ text?: string; binary?: boolean; truncated?: boolean }>(
                `/mcp/servers/${encodeURIComponent(id)}/resource?uri=${encodeURIComponent(uri)}`,
            );
            setPreview({
                uri,
                text: r.binary ? t("integrations-mcp-binary") : `${r.text ?? ""}${r.truncated ? "\n..." : ""}`,
            });
        } catch (err) {
            setPreviewError(errorMessage(err));
        }
    };
    const copy = (uri: string) => {
        void navigator.clipboard?.writeText(`mcp://${uri}`).then(() => {
            setCopied(uri);
            window.setTimeout(() => setCopied((s) => (s === uri ? null : s)), 1500);
        });
    };
    return (
        <>
            {inventory && inventory.prompts.length > 0 && (
                <SettingsSection
                    title={t("integrations-mcp-prompts")}
                    description={t("integrations-mcp-prompts-help", { id })}
                >
                    <SettingsCard>
                        {inventory.prompts.map((p) => (
                            <SettingRow
                                key={p.name}
                                label={<span className="font-mono text-xs break-all">{`/${id}:${p.name}`}</span>}
                                description={p.description ?? p.title}
                            />
                        ))}
                    </SettingsCard>
                </SettingsSection>
            )}
            {inventory && inventory.resources.length > 0 && (
                <SettingsSection
                    title={t("integrations-mcp-resources")}
                    description={t("integrations-mcp-resources-help")}
                >
                    <SettingsCard>
                        {inventory.resources.map((r) => (
                            <SettingRow
                                key={r.uri}
                                label={r.title ?? r.name}
                                description={<span className="font-mono text-xs break-all">{r.uri}</span>}
                                control={
                                    <span className="flex gap-2">
                                        <Button onClick={() => void open(r.uri)}>
                                            {t("integrations-mcp-preview")}
                                        </Button>
                                        <Button
                                            onClick={() => copy(r.uri)}
                                            aria-label={t("integrations-mcp-copy-ref", { name: r.name })}
                                        >
                                            {copied === r.uri ? <Check aria-hidden /> : <Copy aria-hidden />}
                                            {copied === r.uri ? t("integrations-copied") : t("integrations-copy")}
                                        </Button>
                                    </span>
                                }
                            />
                        ))}
                    </SettingsCard>
                    {previewError && <Notice tone="danger">{previewError}</Notice>}
                    {preview && (
                        <pre
                            aria-label={t("integrations-mcp-preview-of", { uri: preview.uri })}
                            className="max-h-64 overflow-auto rounded-2xl border border-default bg-control p-3 font-mono text-xs break-words whitespace-pre-wrap"
                        >
                            {preview.text}
                        </pre>
                    )}
                </SettingsSection>
            )}
            {c && (
                <SettingsSection title={t("integrations-mcp-permissions")}>
                    <SettingsCard>
                        <SettingRow
                            label={t("integrations-mcp-granted")}
                            control={
                                <span className="text-sm text-secondary">
                                    {c.scopes.length ? c.scopes.join(", ") : t("integrations-mcp-none-listed")}
                                </span>
                            }
                        />
                        {c.missingScopes && c.missingScopes.length > 0 && (
                            <SettingRow
                                label={t("integrations-mcp-not-granted")}
                                description={t("integrations-mcp-not-granted-help")}
                                control={
                                    <span className="inline-flex items-center gap-1 text-sm text-warning">
                                        <WarningCircle aria-hidden className="size-4" />
                                        {c.missingScopes.join(", ")}
                                    </span>
                                }
                            />
                        )}
                    </SettingsCard>
                </SettingsSection>
            )}
            <SettingsSection title={t("integrations-mcp-information")}>
                <SettingsCard>
                    {[
                        ...rows,
                        inventory?.serverVersion && {
                            label: t("integrations-version"),
                            value: inventory.serverVersion,
                        },
                        inventory?.protocolVersion && {
                            label: t("integrations-mcp-protocol"),
                            value: `${inventory.protocolVersion}${inventory.era ? `, ${inventory.era}` : ""}`,
                        },
                    ]
                        .filter((r): r is { label: string; value: ReactNode } => !!r)
                        .map((r) => (
                            <SettingRow
                                key={r.label}
                                label={r.label}
                                control={<span className="min-w-0 text-sm break-all text-secondary">{r.value}</span>}
                            />
                        ))}
                </SettingsCard>
            </SettingsSection>
        </>
    );
}

// Detail page wrappers (used by mcp.tsx)

/** The catalogue entry for a server: by record id, else by the address the entry points at. */
export function presetFor(
    cat: McpCatalogResponse | undefined,
    id: string,
    entry?: { url?: string },
): McpCatalogItem | undefined {
    if (!cat) return undefined;
    const byId = cat.entries.find((p) => p.id === id);
    if (byId || !entry?.url) return byId;
    return cat.entries.find((p) => p.server.url === entry.url);
}

/** Tool annotations from the server's inventory, keyed by tool name. Empty until the inventory loads. */
export function useToolHints(id: string, enabled: boolean): Map<string, McpToolHints> {
    const inv = useQuery({ ...mcpInventoryQuery(id), enabled });
    return useMemo(() => new Map((inv.data?.tools ?? []).map((t) => [t.name, t])), [inv.data]);
}

/** Tool annotation badges. */
export function HintBadges({ t }: { t: { readOnly?: boolean; destructive?: boolean } }) {
    return toolBadges(t);
}

/** Sign-in card for servers that use OAuth. Disconnect asks first. */
export function McpConnectionCard({
    id,
    entry,
    preset,
}: {
    id: string;
    entry: { type?: string; url?: string };
    preset: McpPreset | undefined;
}) {
    const t = useT();
    const qc = useQueryClient();
    const [confirm, setConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const conns = useQuery(mcpConnectionsQuery);
    const signedIn = conns.data?.some((c) => c.server === id) ?? false;
    if (entry.type !== "http" || (preset?.auth !== "oauth" && !signedIn)) return null;
    return (
        <>
            {error && <Notice tone="danger">{error}</Notice>}
            <ConnectionCard id={id} onDisconnect={() => setConfirm(true)} />
            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title={t("integrations-mcp-disconnect-named", { name: preset?.name ?? id })}
                description={t("integrations-mcp-disconnect-help")}
                confirmLabel={t("integrations-mcp-disconnect")}
                danger
                onConfirm={() =>
                    void disconnectServer(id)
                        .then(() => {
                            setError(null);
                            void qc.invalidateQueries({ queryKey: ["mcp"] });
                        })
                        .catch((err) => setError(errorMessage(err)))
                }
            />
        </>
    );
}

/** Publisher, links and privacy information from the catalogue entry. */
export function McpCatalogueFacts({ preset }: { preset: McpPreset }) {
    const t = useT();
    const link = (href: string) => (
        <a href={href} target="_blank" rel="noreferrer" className="underline">
            {href}
        </a>
    );
    const rows: { label: string; value: ReactNode }[] = [];
    if (preset.publisher) rows.push({ label: t("integrations-mcp-publisher"), value: preset.publisher });
    if (preset.website) rows.push({ label: t("integrations-mcp-website"), value: link(preset.website) });
    if (preset.privacy) rows.push({ label: t("integrations-mcp-privacy"), value: link(preset.privacy) });
    if (preset.note) rows.push({ label: t("integrations-mcp-note"), value: preset.note });
    if (!rows.length) return null;
    return (
        <SettingsSection title={t("integrations-mcp-about")}>
            <SettingsCard>
                {rows.map((r) => (
                    <SettingRow
                        key={r.label}
                        label={r.label}
                        control={<span className="min-w-0 text-sm break-all text-secondary">{r.value}</span>}
                    />
                ))}
            </SettingsCard>
        </SettingsSection>
    );
}

/** Prompts, resources, permissions and information for a server, loading its inventory. */
export function McpInventorySections({ id }: { id: string }) {
    const inv = useQuery(mcpInventoryQuery(id));
    return (
        <>
            {inv.data?.error && <Notice tone="warning">{inv.data.error}</Notice>}
            <InventorySections id={id} inventory={inv.data} rows={[]} />
        </>
    );
}
