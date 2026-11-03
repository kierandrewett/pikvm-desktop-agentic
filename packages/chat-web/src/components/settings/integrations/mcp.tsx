/**
 * MCP servers: list, catalogue, guided setup and detail pages (see common.tsx for the view model).
 *
 * Live status comes from GET /api/mcp, which starts the configured servers in the user's sandbox and reports which
 * connected, their tools and any error (`?fresh=1` skips the server's 10 minute cache). Remote servers (Streamable
 * HTTP, or the older HTTP with SSE, detected by the server) are tested before saving with POST /api/mcp/test;
 * command servers only run in the sandbox, so setup saves them and then watches /api/mcp until they connect or
 * fail. Each tool has a policy: On (follows the chat's permission mode), Ask every time, or Off, stored on the
 * server entry as `tools` and rendered into the runtime's approval rules by the server.
 *
 * Nothing here loads on app start: the catalogue loads on the catalogue view and the listing on the MCP pages.
 */
import {
    McpServer,
    type McpPreset,
    type McpServerStatus,
    type McpTestResult,
    type McpToolPolicy,
    type McpToolStatus,
} from "@pikvm/chat-protocol";
import { ArrowClockwise, Globe, LockSimple, PlugsConnected, Plus, PuzzlePiece, TerminalWindow } from "@pikvm/icons";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "../../../nav";
import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { api } from "../../../lib/api";
import { msg, translate } from "../../../l10n/runtime";
import { useT } from "../../../l10n/provider";
import { ConfirmDialog } from "../../ui/dialog";
import { useAdminSetting } from "../bindings";
import {
    CheckCard,
    errorMessage,
    InputRow,
    JsonBlock,
    ListSearch,
    makeId,
    useRecords,
    useConfirmMissing,
    useSubView,
    type Check,
    type RecordEntry,
    type Records,
    type Scope,
    type SubView,
} from "./common";
import { GalleryTile, HealthLine, PresetGallery, type GalleryItem, type Health } from "./parts";
import { AdminMcpSettings } from "./mcp-settings";
import {
    DiscoveryCard,
    HintBadges,
    mcpCatalogQuery,
    McpCatalogue,
    McpCatalogueFacts,
    McpConnectionCard,
    McpInventorySections,
    presetFor,
    useDiscovery,
    useOAuthReturn,
    useToolHints,
} from "./mcp-catalogue";
import {
    AdvancedSection,
    Badge,
    Button,
    DangerZone,
    EmptyState,
    fieldClass,
    fromPairs,
    IconTile,
    KeyValueList,
    LinkRow,
    ListEditor,
    Notice,
    NumberField,
    type Pairs,
    SecretRow,
    Segmented,
    Select,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
    TextField,
} from "../kit";

type McpEntry = z.input<typeof McpServer>;
const catalogQuery = mcpCatalogQuery;

/** Live server status (shared with the composer's tool suggestions). Probing starts servers in the sandbox. */
export const mcpStatusQuery = queryOptions({
    queryKey: ["mcp"],
    queryFn: async () => (await api.get<{ servers: McpServerStatus[] }>("/mcp")).servers,
    staleTime: 30_000,
    retry: false,
});

const apiScope = (scope: Scope) => (scope === "admin" ? "global" : "user");
const testKey = (scope: Scope, id: string) => ["mcpTest", scope, id] as const;

async function runTest(scope: Scope, id: string, value: McpEntry): Promise<McpTestResult> {
    return api.post<McpTestResult>("/mcp/test", { id, value, scope: apiScope(scope) });
}

/** Ask the server to start every server again now, and put the answer in the shared cache. */
function useRecheck() {
    const qc = useQueryClient();
    return async () => {
        const servers = (await api.get<{ servers: McpServerStatus[] }>("/mcp?fresh=1")).servers;
        qc.setQueryData(mcpStatusQuery.queryKey, servers);
        return servers;
    };
}

function explain(
    message: string | undefined,
    r?: Pick<McpTestResult, "auth" | "latencyMs">,
): Extract<Check, { state: "error" }> {
    const m = message ?? "";
    const base = { state: "error" as const, detail: m || undefined, latencyMs: r?.latencyMs };
    if (r?.auth === "oauth")
        return {
            ...base,
            title: translate("integrations-mcp-err-oauth-title"),
            fix: translate("integrations-mcp-err-oauth-fix"),
        };
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(m))
        return {
            ...base,
            title: translate("integrations-mcp-err-token-title"),
            fix: translate("integrations-mcp-err-token-fix"),
        };
    if (/does not answer as an MCP server|\b(404|405)\b/.test(m))
        return {
            ...base,
            title: translate("integrations-mcp-err-404-title"),
            fix: translate("integrations-mcp-err-404-fix"),
        };
    if (/No answer after/i.test(m))
        return {
            ...base,
            title: translate("integrations-mcp-err-slow-title"),
            fix: translate("integrations-mcp-err-slow-fix"),
        };
    if (/ENOENT|not found|command not found|No such file/i.test(m))
        return {
            ...base,
            title: translate("integrations-mcp-err-command-title"),
            fix: translate("integrations-mcp-err-command-fix"),
        };
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|timed? ?out|Unable to connect/i.test(m))
        return {
            ...base,
            title: translate("integrations-mcp-err-unreachable-title"),
            fix: translate("integrations-mcp-err-unreachable-fix"),
        };
    return {
        ...base,
        title: translate("integrations-mcp-err-generic-title"),
        fix: translate("integrations-mcp-err-generic-fix"),
    };
}

const okCheck = (r: {
    tools: { name: string }[];
    serverName?: string;
    latencyMs?: number;
    truncated?: number;
}): Check => ({
    state: "ok",
    title: [
        r.serverName
            ? translate("integrations-mcp-connected-to", { name: r.serverName })
            : translate("integrations-mcp-connected-dot"),
        r.tools.length
            ? translate("integrations-mcp-tools-available", { count: r.tools.length + (r.truncated ?? 0) })
            : translate("integrations-mcp-no-tools"),
    ].join(" "),
    items: r.tools.slice(0, 40).map((t) => t.name),
    itemsLabel: translate("integrations-mcp-tools-label"),
    latencyMs: r.latencyMs,
});

function healthOf(
    e: RecordEntry<McpEntry>,
    info: McpServerStatus | undefined,
    loading: boolean,
    paused: boolean,
): Health {
    if (e.entry.enabled === false) return { tone: "muted", text: translate("integrations-health-off") };
    if (e.shadowed) return { tone: "warning", text: translate("integrations-mcp-health-shadowed") };
    if (paused) return { tone: "warning", text: translate("integrations-prov-health-paused") };
    if (info?.connected) {
        const off = Object.values(e.entry.tools ?? {}).filter((p) => p === "off").length;
        return {
            tone: "ok",
            text: off
                ? translate("integrations-mcp-health-connected-off", { count: info.tools.length, off })
                : translate("integrations-mcp-health-connected", { count: info.tools.length }),
        };
    }
    if (info?.error) return { tone: "error", text: explain(info.error).title };
    if (loading) return { tone: "busy", text: translate("integrations-mcp-health-starting") };
    return { tone: "muted", text: translate("integrations-health-unchecked") };
}

const addressOf = (e: McpEntry) =>
    (e.type ?? "stdio") === "stdio" ? [e.command, ...(e.args ?? [])].filter(Boolean).join(" ") : (e.url ?? "");

function ServerIcon({ type, builtin, size = "md" }: { type?: string; builtin?: boolean; size?: "md" | "lg" }) {
    const Icon = builtin ? PuzzlePiece : type === "stdio" ? TerminalWindow : Globe;
    return (
        <IconTile size={size}>
            <Icon aria-hidden />
        </IconTile>
    );
}

const transportLabel = (type: string | undefined) =>
    type === "stdio" || !type
        ? translate("integrations-mcp-transport-stdio")
        : type === "sse"
          ? translate("integrations-mcp-transport-sse")
          : translate("integrations-mcp-transport-http");

// List

function McpRow({
    rec,
    e,
    view,
    health,
}: {
    rec: Records<McpEntry>;
    e: RecordEntry<McpEntry>;
    view: SubView;
    health: Health;
}) {
    const t = useT();
    const [error, setError] = useState<string | null>(null);
    return (
        <LinkRow
            id={`mcp-${e.owner}-${e.id}`}
            icon={<ServerIcon type={e.entry.type ?? "stdio"} />}
            label={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {e.id}
                    {e.owner === "global" && (
                        <Badge>
                            <LockSimple aria-hidden /> {t("integrations-managed")}
                        </Badge>
                    )}
                </span>
            }
            description={
                <span className="flex min-w-0 flex-col">
                    {error ? <span className="text-danger">{error}</span> : <HealthLine health={health} />}
                    <span className="truncate font-mono text-xs text-tertiary">{addressOf(e.entry)}</span>
                </span>
            }
            onClick={() => view.go({ id: e.id })}
            trailing={
                <Switch
                    checked={e.entry.enabled !== false}
                    disabled={!e.editable}
                    label={t("integrations-switch-on", { name: e.id })}
                    onChange={(on) => {
                        setError(null);
                        void rec.save(e.id, { ...e.entry, enabled: on }).catch((err) => setError(errorMessage(err)));
                    }}
                />
            }
        />
    );
}

function McpList({ scope, rec, view }: { scope: Scope; rec: Records<McpEntry>; view: SubView }) {
    const t = useT();
    const status = useQuery(mcpStatusQuery);
    const recheck = useRecheck();
    const [checking, setChecking] = useState(false);
    const infoFor = (id: string) => status.data?.find((s) => s.name === id);
    const builtins = scope === "user" ? (status.data ?? []).filter((s) => s.owner === "builtin") : [];
    const global = scope === "user" ? rec.entries.filter((e) => e.owner === "global") : [];
    const own = rec.entries.filter((e) => e.owner === "user");
    const paused = scope === "user" && rec.lock === "policy";
    const rows = (list: RecordEntry<McpEntry>[]) =>
        list.map((e) => (
            <McpRow
                key={`${e.owner}:${e.id}`}
                rec={rec}
                e={e}
                view={view}
                health={healthOf(e, infoFor(e.id), status.isLoading || checking, paused && e.owner === "user")}
            />
        ));
    const check = async () => {
        setChecking(true);
        await recheck().catch(() => undefined);
        setChecking(false);
    };

    return (
        <SettingsPage
            sectionNav
            title={t("integrations-mcp-title")}
            actions={[
                rec.writable &&
                    own.length > 0 && {
                        label: t("integrations-mcp-add"),
                        icon: <Plus />,
                        onSelect: () => view.go({ add: "catalog" }),
                    },
                rec.entries.length > 0 && {
                    label: t("integrations-mcp-check-again"),
                    icon: <ArrowClockwise />,
                    busy: checking || status.isFetching,
                    onSelect: () => void check(),
                },
            ]}
        >
            {paused && (
                <Notice tone={own.length ? "warning" : "neutral"}>
                    {own.length ? t("integrations-mcp-policy-paused") : t("integrations-mcp-policy-blocked")}
                </Notice>
            )}
            {status.isError && (
                <Notice
                    tone="danger"
                    action={
                        <Button busy={checking} onClick={() => void check()}>
                            {t("integrations-try-again")}
                        </Button>
                    }
                >
                    {t("integrations-mcp-check-servers-failed", { error: errorMessage(status.error) })}
                </Notice>
            )}
            {global.length > 0 && (
                <SettingsSection
                    title={t("integrations-prov-org-title")}
                    description={t("integrations-mcp-org-description")}
                >
                    <SettingsCard>{rows(global)}</SettingsCard>
                </SettingsSection>
            )}
            <SettingsSection
                title={
                    scope === "admin"
                        ? t("integrations-mcp-everyone")
                        : global.length
                          ? t("integrations-prov-yours")
                          : undefined
                }
                description={
                    scope === "admin"
                        ? t("integrations-mcp-everyone-description")
                        : t("integrations-mcp-yours-description")
                }
            >
                <SettingsCard>
                    {rec.loading && <EmptyState loading>{t("integrations-mcp-loading")}</EmptyState>}
                    {!rec.loading && own.length === 0 && (
                        <EmptyState
                            size="block"
                            icon={PuzzlePiece}
                            title={
                                scope === "admin" ? t("integrations-mcp-empty-admin") : t("integrations-mcp-empty-user")
                            }
                            description={
                                !rec.writable ? t("integrations-mcp-empty-off") : t("integrations-mcp-empty-help")
                            }
                        />
                    )}
                    {rows(own)}
                </SettingsCard>
            </SettingsSection>
            {builtins.length > 0 && (
                <SettingsSection title={t("integrations-mcp-builtin")} description={t("integrations-mcp-builtin-help")}>
                    <SettingsCard>
                        {builtins.map((s) => (
                            <SettingRow
                                key={s.name}
                                icon={<ServerIcon builtin />}
                                label={s.name}
                                description={
                                    <HealthLine
                                        health={
                                            s.connected
                                                ? {
                                                      tone: "ok",
                                                      text: t("integrations-mcp-tools", { count: s.tools.length }),
                                                  }
                                                : { tone: "error", text: s.error ?? t("integrations-mcp-not-running") }
                                        }
                                    />
                                }
                            />
                        ))}
                    </SettingsCard>
                </SettingsSection>
            )}
            {scope === "admin" && <PersonalServersPolicy />}
            {rec.writable && own.length === 0 && !rec.loading && <Catalogue rec={rec} view={view} />}
            {scope === "admin" && <AdminMcpSettings />}
        </SettingsPage>
    );
}

/** Where the "users may add MCP servers" policy lives, as a link (the key has one home: Models and policy). */
function PersonalServersPolicy() {
    const t = useT();
    const b = useAdminSetting<boolean>("policy.users.customMcp");
    const navigate = useNavigate();
    return (
        <SettingsSection>
            <SettingsCard>
                <LinkRow
                    label={t("integrations-personal-servers")}
                    description={
                        b.loading
                            ? t("integrations-loading")
                            : b.value === false
                              ? t("integrations-mcp-personal-off")
                              : t("integrations-mcp-personal-on")
                    }
                    onClick={() =>
                        void navigate({
                            to: "/settings/$section",
                            params: { section: "admin-models" },
                            hash: "policy.users.customMcp",
                        })
                    }
                />
            </SettingsCard>
        </SettingsSection>
    );
}

// Catalogue

function Catalogue({ rec, view }: { rec: Records<McpEntry>; view: SubView }) {
    return (
        <McpCatalogue
            entries={rec.entries}
            onOpen={(id) => view.go({ id })}
            onAdd={(id) => view.go({ add: id })}
            onCustom={() => view.go({ add: "custom" })}
        />
    );
}

function McpCatalog({ rec, view }: { rec: Records<McpEntry>; view: SubView }) {
    const t = useT();
    return (
        <SettingsPage
            title={t("integrations-mcp-add-title")}
            back={{ label: t("integrations-mcp-title"), onClick: () => view.go({}) }}
        >
            <Catalogue rec={rec} view={view} />
        </SettingsPage>
    );
}

// Setup

function buildFromPreset(preset: McpPreset, values: Record<number, string>): McpEntry {
    const s: McpEntry = {
        ...(preset.server as McpEntry),
        enabled: true,
        ...(preset.id !== "custom" ? { catalogId: preset.id } : {}),
    };
    let args = [...(s.args ?? [])];
    preset.inputs.forEach((input, i) => {
        const v = (values[i] ?? "").trim() || input.defaultValue || "";
        const t = input.target;
        if (t.kind === "arg") {
            args = args
                .map((a) => (a.includes(t.placeholder) ? a.replace(t.placeholder, v) : a))
                .filter((a) => a !== "");
            return;
        }
        if (!v) return;
        if (t.kind === "header") s.headers = { ...s.headers, [t.name]: `${t.prefix ?? ""}${v}` };
        if (t.kind === "env") s.env = { ...s.env, [t.name]: v };
        if (t.kind === "url") s.url = v;
    });
    if (args.length) s.args = args;
    return JSON.parse(JSON.stringify(s)) as McpEntry;
}

/** Re-check /api/mcp until `id` connects or reports an error, at most two minutes. */
function usePollUntil() {
    const recheck = useRecheck();
    const timer = useRef<number | undefined>(undefined);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    return (id: string, onDone: (info: McpServerStatus | undefined, timedOut: boolean) => void) => {
        const started = Date.now();
        const tick = async () => {
            const list = await recheck().catch(() => undefined);
            const info = list?.find((s) => s.name === id);
            if (info?.connected || info?.error) return onDone(info, false);
            if (Date.now() - started > 120_000) return onDone(info, true);
            timer.current = window.setTimeout(() => void tick(), 2500);
        };
        void tick();
    };
}

function McpSetup({
    scope,
    rec,
    view,
    presetId,
}: {
    scope: Scope;
    rec: Records<McpEntry>;
    view: SubView;
    presetId: string;
}) {
    const t = useT();
    const qc = useQueryClient();
    const cat = useQuery(catalogQuery);
    const poll = usePollUntil();
    const custom = presetId === "custom";
    const preset = custom ? cat.data?.custom : cat.data?.entries.find((p) => p.id === presetId);
    const [values, setValues] = useState<Record<number, string>>({});
    const [name, setName] = useState("");
    const [type, setType] = useState<"http" | "stdio">("http");
    const [url, setUrl] = useState("");
    const [headers, setHeaders] = useState<Pairs>([]);
    const [command, setCommand] = useState("");
    const [args, setArgs] = useState<string[]>([]);
    const [env, setEnv] = useState<Pairs>([]);
    const [check, setCheck] = useState<Check>({ state: "idle" });
    const [detected, setDetected] = useState<McpTestResult | null>(null);
    const [missing, setMissing] = useState<string | null>(null);
    const [savedId, setSavedId] = useState<string | null>(null);
    // Look at the address as it settles, so the identity card and the sign-in hint appear before saving.
    const discovery = useDiscovery(custom && type === "http" ? url : "", scope === "admin" ? "global" : "user");
    const discovered = discovery.state.status === "done" && discovery.state.result.ok ? discovery.state.result : null;
    const discoveredName = discovered?.serverTitle ?? discovered?.serverName;
    useEffect(() => {
        if (discoveredName) setName((n) => n || discoveredName);
    }, [discoveredName]);
    const back = { label: t("integrations-mcp-add-title"), onClick: () => view.go({ add: "catalog" }) };

    if (cat.isLoading)
        return (
            <SettingsPage title={t("integrations-connect")} back={back}>
                <Notice>{t("integrations-loading-dots")}</Notice>
            </SettingsPage>
        );
    if (!preset) {
        return (
            <SettingsPage title={t("integrations-not-found")} back={back}>
                <Notice>{t("integrations-mcp-not-in-catalogue")}</Notice>
            </SettingsPage>
        );
    }
    const taken = rec.entries.map((e) => e.id);
    if (!custom && taken.includes(preset.id) && !savedId) {
        return (
            <SettingsPage title={t("integrations-connect-named", { name: preset.name })} back={back}>
                <Notice action={<Button onClick={() => view.go({ id: preset.id })}>{t("integrations-open")}</Button>}>
                    {t("integrations-mcp-already-added", { name: preset.name })}
                </Notice>
            </SettingsPage>
        );
    }

    const kind = custom ? type : (preset.server.type ?? "stdio");
    const local = kind === "stdio";
    const id =
        savedId ??
        (custom ? makeId(name || detected?.serverName || discovered?.serverName || "server", taken) : preset.id);
    const entry = (): McpEntry => {
        if (!custom) {
            const e = buildFromPreset(preset, values);
            // A remote preset that only answered over SSE is saved with that transport.
            return detected?.ok && detected.transport === "sse" ? { ...e, type: "sse" } : e;
        }
        return JSON.parse(
            JSON.stringify({
                enabled: true,
                type: local ? "stdio" : (detected?.ok && detected.transport) || "http",
                url: local ? undefined : url.trim() || undefined,
                headers: local ? undefined : fromPairs(headers),
                command: local ? command.trim() || undefined : undefined,
                args: local && args.length ? args : undefined,
                env: local ? fromPairs(env) : undefined,
            }),
        ) as McpEntry;
    };

    const validate = (): boolean => {
        if (custom && !local && !url.trim()) return (setMissing(t("integrations-mcp-enter-url")), false);
        if (custom && local && !command.trim()) return (setMissing(t("integrations-mcp-enter-command")), false);
        if (custom && local && !name.trim()) return (setMissing(t("integrations-mcp-enter-name")), false);
        const gap = preset.inputs.find((inp, i) => !inp.optional && !inp.defaultValue && !(values[i] ?? "").trim());
        if (gap) return (setMissing(t("integrations-enter-field", { label: gap.label.toLowerCase() })), false);
        const parsed = McpServer.safeParse(entry());
        if (!parsed.success)
            return (setMissing(parsed.error.issues[0]?.message ?? t("integrations-mcp-check-settings")), false);
        setMissing(null);
        return true;
    };

    const save = async (e: McpEntry) => {
        await rec.save(id, e);
        setSavedId(id);
        void qc.invalidateQueries({ queryKey: mcpStatusQuery.queryKey });
    };

    const startInSandbox = async (e: McpEntry) => {
        setCheck({ state: "running", text: t("integrations-saving") });
        try {
            await save(e);
        } catch (err) {
            return setCheck({ state: "error", title: t("integrations-could-not-save"), detail: errorMessage(err) });
        }
        setCheck({
            state: "running",
            text: t("integrations-mcp-starting-sandbox"),
        });
        poll(id, (info, timedOut) => {
            if (info?.connected) {
                setCheck(okCheck({ tools: info.tools }));
                window.setTimeout(() => view.go({ id }), 900);
            } else if (timedOut) {
                setCheck({
                    state: "error",
                    title: t("integrations-mcp-still-not-running"),
                    fix: t("integrations-mcp-still-not-running-fix"),
                });
            } else setCheck(explain(info?.error));
        });
    };

    /** Remote only: connect and list tools without saving. */
    const probe = async (): Promise<McpTestResult | undefined> => {
        if (!validate()) return undefined;
        setCheck({ state: "running", text: t("integrations-mcp-connecting") });
        try {
            const r = await runTest(scope, id, entry());
            qc.setQueryData(testKey(scope, id), r);
            setDetected(r);
            if (r.ok && custom && !name.trim() && (r.serverName ?? discovered?.serverName))
                setName(r.serverName ?? discovered?.serverName ?? "");
            setCheck(r.ok ? okCheck(r) : explain(r.error, r));
            return r;
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-check-failed"), detail: errorMessage(err) });
            return undefined;
        }
    };

    const connect = async () => {
        if (!validate()) return;
        if (local) return startInSandbox(entry());
        const r = await probe();
        if (!r?.ok) return;
        try {
            await save(entry());
            view.go({ id });
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-could-not-save"), detail: errorMessage(err) });
        }
    };

    const busy = check.state === "running";
    return (
        <SettingsPage
            title={custom ? t("integrations-mcp-add-custom") : t("integrations-connect-named", { name: preset.name })}
            back={back}
        >
            <SettingsSection>
                <SettingsCard>
                    <SettingRow
                        icon={<ServerIcon type={kind} size="lg" />}
                        label={custom ? t("integrations-mcp-custom") : preset.name}
                        description={custom ? t("integrations-mcp-custom-description") : preset.description}
                        control={<span className="text-xs text-tertiary">{transportLabel(kind)}</span>}
                    />
                </SettingsCard>
                {preset.note && <Notice tone="warning">{preset.note}</Notice>}
            </SettingsSection>
            <form
                className="contents"
                onSubmit={(ev) => {
                    ev.preventDefault();
                    void connect();
                }}
            >
                <SettingsSection title={t("integrations-details")}>
                    <SettingsCard>
                        {custom && (
                            <>
                                <SettingRow
                                    label={t("integrations-mcp-how-runs")}
                                    description={
                                        local
                                            ? t("integrations-mcp-how-runs-local")
                                            : t("integrations-mcp-how-runs-remote")
                                    }
                                    control={
                                        <Segmented
                                            label={t("integrations-mcp-how-runs")}
                                            value={type}
                                            options={[
                                                { value: "http", label: t("integrations-mcp-remote-url") },
                                                { value: "stdio", label: t("integrations-mcp-command") },
                                            ]}
                                            onChange={(next) => {
                                                setType(next);
                                                setCheck({ state: "idle" });
                                                setDetected(null);
                                            }}
                                        />
                                    }
                                />
                                {!local ? (
                                    <>
                                        <InputRow
                                            input={{
                                                target: { kind: "baseUrl" },
                                                label: t("integrations-mcp-server-url"),
                                                help: t("integrations-mcp-server-url-help"),
                                            }}
                                            value={url}
                                            onChange={(v) => {
                                                setUrl(v);
                                                setDetected(null);
                                            }}
                                        />
                                        <DiscoveryCard state={discovery.state} retry={discovery.retry} />
                                        <SettingRow
                                            stack
                                            label={t("integrations-prov-headers-list")}
                                            description={t("integrations-mcp-headers-help")}
                                            control={
                                                <KeyValueList
                                                    label={t("integrations-prov-headers-list")}
                                                    value={headers}
                                                    onChange={setHeaders}
                                                    secret
                                                />
                                            }
                                        />
                                    </>
                                ) : (
                                    <>
                                        <InputRow
                                            input={{
                                                target: { kind: "arg", placeholder: "" },
                                                label: t("integrations-mcp-command"),
                                                help: t("integrations-mcp-command-help"),
                                            }}
                                            value={command}
                                            onChange={setCommand}
                                        />
                                        <SettingRow
                                            stack
                                            label={t("integrations-mcp-arguments")}
                                            description={t("integrations-mcp-arguments-help")}
                                            control={
                                                <ListEditor
                                                    label={t("integrations-mcp-arguments")}
                                                    value={args}
                                                    onChange={setArgs}
                                                    placeholder="-y @scope/server"
                                                />
                                            }
                                        />
                                        <SettingRow
                                            stack
                                            label={t("integrations-mcp-environment")}
                                            description={t("integrations-mcp-environment-help")}
                                            control={
                                                <KeyValueList
                                                    label={t("integrations-mcp-environment")}
                                                    value={env}
                                                    onChange={setEnv}
                                                    keyPlaceholder="NAME"
                                                    secret
                                                />
                                            }
                                        />
                                    </>
                                )}
                                <InputRow
                                    input={{
                                        target: { kind: "arg", placeholder: "" },
                                        label: t("integrations-prov-name-label"),
                                        help: local
                                            ? t("integrations-mcp-name-help-local")
                                            : t("integrations-mcp-name-help-remote"),
                                        optional: !local,
                                    }}
                                    value={name}
                                    onChange={setName}
                                />
                            </>
                        )}
                        {!custom &&
                            preset.inputs.map((input, i) => (
                                <InputRow
                                    key={i}
                                    input={input}
                                    value={values[i] ?? ""}
                                    onChange={(v) => setValues((s) => ({ ...s, [i]: v }))}
                                />
                            ))}
                        {!custom && preset.inputs.length === 0 && (
                            <EmptyState>
                                {local ? t("integrations-mcp-nothing-local") : t("integrations-prov-nothing-to-fill")}
                            </EmptyState>
                        )}
                    </SettingsCard>
                    {missing && <Notice tone="danger">{missing}</Notice>}
                    <CheckCard check={check} />
                    {detected?.ok && <ToolPreview result={detected} />}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {savedId ? (
                            <Button onClick={() => view.go({ id })}>{t("integrations-mcp-open")}</Button>
                        ) : (
                            !local && (
                                <Button
                                    disabled={busy}
                                    onClick={() =>
                                        validate() &&
                                        void save(entry()).then(
                                            () => view.go({ id }),
                                            (err) =>
                                                setCheck({
                                                    state: "error",
                                                    title: t("integrations-could-not-save"),
                                                    detail: errorMessage(err),
                                                }),
                                        )
                                    }
                                >
                                    {t("integrations-save-untested")}
                                </Button>
                            )
                        )}
                        <Button variant="primary" size="md" type="submit" busy={busy}>
                            {local
                                ? t("integrations-mcp-add-start")
                                : check.state === "error"
                                  ? t("integrations-test-again")
                                  : t("integrations-mcp-test-add")}
                        </Button>
                    </div>
                </SettingsSection>
            </form>
        </SettingsPage>
    );
}

/** First tools of a successful test, with their descriptions, before the server is saved. */
function ToolPreview({ result }: { result: McpTestResult }) {
    const t = useT();
    const shown = result.tools.slice(0, 6);
    if (!shown.length) return null;
    return (
        <SettingsCard>
            {shown.map((tool) => (
                <SettingRow
                    key={tool.name}
                    label={<span className="font-mono text-xs">{tool.name}</span>}
                    description={tool.description}
                    control={<ToolTags readOnly={tool.readOnly} destructive={tool.destructive} />}
                />
            ))}
            {result.tools.length + (result.truncated ?? 0) > shown.length && (
                <EmptyState>
                    {t("integrations-mcp-more-tools", {
                        count: result.tools.length + (result.truncated ?? 0) - shown.length,
                    })}
                </EmptyState>
            )}
        </SettingsCard>
    );
}

function ToolTags({ readOnly, destructive }: { readOnly?: boolean; destructive?: boolean }) {
    return <HintBadges t={{ readOnly, destructive }} />;
}

// Detail

interface ToolRow {
    /** Server's tool name: the key of `tools`. */
    tool: string;
    description?: string;
    readOnly?: boolean;
    destructive?: boolean;
}

const PAGE = 100;

function McpDetail({ scope, rec, view, id }: { scope: Scope; rec: Records<McpEntry>; view: SubView; id: string }) {
    const t = useT();
    const qc = useQueryClient();
    const cat = useQuery(catalogQuery);
    const status = useQuery(mcpStatusQuery);
    const recheck = useRecheck();
    const lastTest = useQuery({
        queryKey: testKey(scope, id),
        queryFn: () => null as McpTestResult | null,
        enabled: false,
        staleTime: Infinity,
    }).data;
    const e = rec.get(id);
    const confirming = useConfirmMissing(!e, rec.loading);
    const [check, setCheck] = useState<Check>({ state: "idle" });
    const [confirm, setConfirm] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const back = { label: t("integrations-mcp-title"), onClick: () => view.go({}) };
    const info = status.data?.find((s) => s.name === id);
    const preset = presetFor(cat.data, id, e?.entry);
    const title = preset?.name ?? id;
    const hints = useToolHints(id, e?.entry.type === "http");

    const tools = useMemo<ToolRow[]>(() => {
        const notes = new Map((lastTest?.tools ?? []).map((t) => [t.name, t]));
        const live: ToolRow[] = (info?.tools ?? []).map((t: McpToolStatus) => {
            const tool = t.tool ?? t.label.split("/").pop() ?? t.name;
            const n = notes.get(tool);
            return {
                tool,
                description: t.description || n?.description,
                readOnly: n?.readOnly ?? hints.get(tool)?.readOnly,
                destructive: n?.destructive ?? hints.get(tool)?.destructive,
            };
        });
        if (live.length) return live;
        return (lastTest?.tools ?? []).map((t) => ({ tool: t.name, ...t }));
    }, [info, lastTest, hints]);

    if (!e) {
        return (
            <SettingsPage title={confirming ? t("integrations-loading") : t("integrations-not-found")} back={back}>
                <Notice>{confirming ? t("integrations-loading-dots") : t("integrations-mcp-gone")}</Notice>
            </SettingsPage>
        );
    }
    const entry = e.entry;
    const editable = e.editable;
    const local = (entry.type ?? "stdio") === "stdio";
    const paused = scope === "user" && e.owner === "user" && rec.lock === "policy";
    const health = healthOf(e, info, status.isLoading, paused);

    const update = async (patch: Partial<McpEntry>) => {
        setSaveError(null);
        try {
            await rec.save(id, JSON.parse(JSON.stringify({ ...entry, ...patch })) as McpEntry);
            void qc.invalidateQueries({ queryKey: mcpStatusQuery.queryKey });
        } catch (err) {
            setSaveError(errorMessage(err));
            throw err;
        }
    };

    const test = async () => {
        if (local) {
            setCheck({ state: "running", text: t("integrations-mcp-starting-it") });
            try {
                const list = await recheck();
                const now = list.find((s) => s.name === id);
                setCheck(
                    now?.connected
                        ? okCheck({ tools: now.tools })
                        : explain(now?.error ?? t("integrations-mcp-not-running")),
                );
            } catch (err) {
                setCheck({ state: "error", title: t("integrations-check-failed"), detail: errorMessage(err) });
            }
            return;
        }
        setCheck({ state: "running", text: t("integrations-mcp-connecting") });
        try {
            const r = await runTest(scope, id, entry);
            qc.setQueryData(testKey(scope, id), r);
            setCheck(r.ok ? okCheck(r) : explain(r.error, r));
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-check-failed"), detail: errorMessage(err) });
        }
    };

    const setPolicy = (tool: string, policy: McpToolPolicy | "on") => {
        const next = { ...(entry.tools ?? {}) };
        if (policy === "on") delete next[tool];
        else next[tool] = policy;
        return update({ tools: Object.keys(next).length ? next : undefined }).catch(() => {});
    };

    const secretRows = [
        ...Object.keys(entry.headers ?? {}).map((k) => ({ kind: "headers" as const, k })),
        ...Object.keys(entry.env ?? {}).map((k) => ({ kind: "env" as const, k })),
    ];

    return (
        <SettingsPage
            title={title}
            back={back}
            actions={[
                {
                    label: local ? t("integrations-mcp-check-again") : t("integrations-test-connection"),
                    icon: local ? <ArrowClockwise /> : <PlugsConnected />,
                    busy: check.state === "running",
                    onSelect: () => void test(),
                },
            ]}
        >
            <SettingsSection>
                {scope === "user" && e.owner === "global" && <Notice>{t("integrations-mcp-managed-note")}</Notice>}
                {e.shadowed && <Notice tone="warning">{t("integrations-mcp-shadowed-note")}</Notice>}
                {saveError && <Notice tone="danger">{saveError}</Notice>}
                <SettingsCard>
                    <SettingRow
                        icon={<ServerIcon type={entry.type ?? "stdio"} size="lg" />}
                        label={t("integrations-mcp-use")}
                        description={<HealthLine health={health} />}
                        control={
                            <Switch
                                checked={entry.enabled !== false}
                                disabled={!editable}
                                label={t("integrations-switch-on", { name: id })}
                                onChange={(on) => void update({ enabled: on }).catch(() => {})}
                            />
                        }
                    />
                </SettingsCard>
                {check.state === "idle" && info?.error && entry.enabled !== false && (
                    <CheckCard check={explain(info.error)} />
                )}
                <CheckCard check={check} />
            </SettingsSection>
            <SettingsSection title={t("integrations-connection")}>
                <SettingsCard>
                    <SettingRow
                        label={t("integrations-mcp-runs-as")}
                        control={<span className="text-sm text-secondary">{transportLabel(entry.type)}</span>}
                    />
                    <SettingRow
                        label={local ? t("integrations-mcp-command") : t("integrations-mcp-url")}
                        control={<span className="truncate font-mono text-xs text-secondary">{addressOf(entry)}</span>}
                    />
                    {editable &&
                        secretRows.map(({ kind, k }) => (
                            <SecretRow
                                key={`${kind}:${k}`}
                                label={k}
                                description={
                                    kind === "headers" ? t("integrations-mcp-header") : t("integrations-mcp-env-var")
                                }
                                isSet={!!(entry[kind] ?? {})[k]}
                                editable={editable}
                                optional
                                onSave={(v) => {
                                    const next = { ...(entry[kind] ?? {}) };
                                    if (v === undefined) delete next[k];
                                    else next[k] = v;
                                    return update({ [kind]: Object.keys(next).length ? next : undefined });
                                }}
                            />
                        ))}
                    {!editable && secretRows.length > 0 && (
                        <SettingRow
                            label={t("integrations-mcp-secrets")}
                            control={
                                <span className="text-sm text-secondary">
                                    {t("integrations-mcp-secrets-kept", { count: secretRows.length })}
                                </span>
                            }
                        />
                    )}
                </SettingsCard>
            </SettingsSection>
            <ToolList
                tools={tools}
                policies={entry.tools ?? {}}
                editable={editable}
                loading={status.isLoading && !lastTest}
                running={entry.enabled !== false}
                onPolicy={setPolicy}
            />
            {editable && (
                <AdvancedSection label={t("integrations-advanced")}>
                    <SettingsCard>
                        {local ? (
                            <>
                                <SettingRow
                                    label={t("integrations-mcp-command")}
                                    control={
                                        <TextField
                                            value={entry.command ?? ""}
                                            onCommit={(v) => void update({ command: v || undefined }).catch(() => {})}
                                            label={t("integrations-mcp-command")}
                                            mono
                                        />
                                    }
                                />
                                <SettingRow
                                    stack
                                    label={t("integrations-mcp-arguments")}
                                    control={
                                        <ListEditor
                                            label={t("integrations-mcp-arguments")}
                                            value={entry.args ?? []}
                                            onChange={(a) =>
                                                void update({ args: a.length ? a : undefined }).catch(() => {})
                                            }
                                        />
                                    }
                                />
                                <SettingRow
                                    label={t("integrations-mcp-cwd")}
                                    control={
                                        <TextField
                                            value={entry.cwd ?? ""}
                                            onCommit={(v) => void update({ cwd: v || undefined }).catch(() => {})}
                                            label={t("integrations-mcp-cwd")}
                                            placeholder={t("integrations-default")}
                                            mono
                                        />
                                    }
                                />
                            </>
                        ) : (
                            <>
                                <SettingRow
                                    label={t("integrations-mcp-url")}
                                    control={
                                        <TextField
                                            value={entry.url ?? ""}
                                            onCommit={(v) => void update({ url: v || undefined }).catch(() => {})}
                                            label={t("integrations-mcp-url")}
                                            type="url"
                                            mono
                                            className="w-64"
                                        />
                                    }
                                />
                                <SettingRow
                                    label={t("integrations-mcp-transport")}
                                    description={t("integrations-mcp-transport-help")}
                                    control={
                                        <Select
                                            label={t("integrations-mcp-transport")}
                                            value={entry.type === "sse" ? "sse" : "http"}
                                            options={[
                                                { value: "http", label: "Streamable HTTP" },
                                                { value: "sse", label: "HTTP with SSE" },
                                            ]}
                                            onChange={(next) => void update({ type: next }).catch(() => {})}
                                        />
                                    }
                                />
                            </>
                        )}
                        <SettingRow
                            label={t("integrations-mcp-timeout")}
                            description={t("integrations-mcp-timeout-help")}
                            control={
                                <NumberField
                                    value={entry.timeout}
                                    onCommit={(v) => void update({ timeout: v }).catch(() => {})}
                                    label={t("integrations-mcp-timeout")}
                                    min={0}
                                    step={1000}
                                    unit="ms"
                                />
                            }
                        />
                        <AddSecretRow
                            onAdd={(kind, k, v) => update({ [kind]: { ...(entry[kind] ?? {}), [k]: v } })}
                            local={local}
                        />
                    </SettingsCard>
                    <JsonBlock value={{ [id]: entry }} />
                </AdvancedSection>
            )}
            <McpConnectionCard id={id} entry={entry} preset={preset} />
            {preset && <McpCatalogueFacts preset={preset} />}
            {entry.type === "http" && entry.enabled !== false && <McpInventorySections id={id} />}
            {editable && (
                <DangerZone>
                    <SettingRow
                        label={t("integrations-mcp-remove")}
                        description={t("integrations-mcp-remove-help")}
                        control={
                            <Button variant="danger" onClick={() => setConfirm(true)}>
                                {t("integrations-remove")}
                            </Button>
                        }
                    />
                </DangerZone>
            )}
            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title={t("integrations-remove-named", { name: id })}
                description={t("integrations-mcp-remove-confirm")}
                confirmLabel={t("integrations-remove")}
                danger
                onConfirm={() =>
                    void rec
                        .remove(id)
                        .then(() => {
                            void qc.invalidateQueries({ queryKey: mcpStatusQuery.queryKey });
                            view.go({});
                        })
                        .catch((err) => setSaveError(errorMessage(err)))
                }
            />
        </SettingsPage>
    );
}

const POLICY_OPTIONS = [
    { value: "on", label: msg("integrations-mcp-policy-on") },
    { value: "ask", label: msg("integrations-mcp-policy-ask") },
    { value: "off", label: msg("integrations-health-off") },
] as const;

/**
 * The server's tools with their descriptions and a policy each. Long lists render 100 rows at a time so a server
 * with thousands of tools does not block the page.
 */
function ToolList({
    tools,
    policies,
    editable,
    loading,
    running,
    onPolicy,
}: {
    tools: ToolRow[];
    policies: Record<string, McpToolPolicy>;
    editable: boolean;
    loading: boolean;
    running: boolean;
    onPolicy: (tool: string, policy: McpToolPolicy | "on") => void;
}) {
    const t = useT();
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(PAGE);
    const q = query.trim().toLowerCase();
    const shown = q ? tools.filter((r) => `${r.tool} ${r.description ?? ""}`.toLowerCase().includes(q)) : tools;
    const off = tools.filter((r) => policies[r.tool] === "off").length;
    const ask = tools.filter((r) => policies[r.tool] === "ask").length;
    const policyOptions = POLICY_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }));
    return (
        <SettingsSection
            title={t("integrations-mcp-tools-label")}
            description={
                tools.length
                    ? t("integrations-mcp-tools-summary", {
                          parts: [
                              t("integrations-mcp-tools", { count: tools.length }),
                              off ? t("integrations-mcp-tools-off-count", { count: off }) : undefined,
                              ask ? t("integrations-mcp-tools-ask-count", { count: ask }) : undefined,
                          ]
                              .filter(Boolean)
                              .join(", "),
                      })
                    : undefined
            }
            action={
                tools.length > 8 && (
                    <ListSearch
                        value={query}
                        onChange={(v) => (setQuery(v), setLimit(PAGE))}
                        label={t("integrations-mcp-search-tools")}
                    />
                )
            }
        >
            <SettingsCard>
                {loading && <EmptyState loading>{t("integrations-mcp-tools-loading")}</EmptyState>}
                {!loading && tools.length === 0 && (
                    <EmptyState>
                        {running ? t("integrations-mcp-tools-none") : t("integrations-mcp-tools-off")}
                    </EmptyState>
                )}
                {!loading && tools.length > 0 && shown.length === 0 && (
                    <EmptyState>{t("integrations-mcp-tools-no-match")}</EmptyState>
                )}
                {shown.slice(0, limit).map((row) => {
                    const policy = policies[row.tool] ?? "on";
                    return (
                        <SettingRow
                            key={row.tool}
                            label={
                                <span className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono text-xs break-all">{row.tool}</span>
                                    <ToolTags readOnly={row.readOnly} destructive={row.destructive} />
                                </span>
                            }
                            description={row.description}
                            control={
                                editable ? (
                                    <Segmented
                                        label={t("integrations-mcp-policy-for", { tool: row.tool })}
                                        value={policy}
                                        options={policyOptions}
                                        onChange={(p) => onPolicy(row.tool, p)}
                                    />
                                ) : (
                                    policy !== "on" && (
                                        <Badge>
                                            {policy === "off"
                                                ? t("integrations-health-off")
                                                : t("integrations-mcp-asks-first")}
                                        </Badge>
                                    )
                                )
                            }
                        />
                    );
                })}
                {shown.length > limit && (
                    <div className="flex justify-center px-4 py-3">
                        <Button onClick={() => setLimit((l) => l + PAGE)}>
                            {t("integrations-mcp-show-more", {
                                count: Math.min(PAGE, shown.length - limit),
                                left: shown.length - limit,
                            })}
                        </Button>
                    </div>
                )}
            </SettingsCard>
        </SettingsSection>
    );
}

/** Add one header (URL servers) or environment variable (command servers). */
function AddSecretRow({
    local,
    onAdd,
}: {
    local: boolean;
    onAdd: (kind: "headers" | "env", name: string, value: string) => Promise<void>;
}) {
    const t = useT();
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const kind = local ? "env" : "headers";
    return (
        <SettingRow
            stack
            label={local ? t("integrations-mcp-add-env") : t("integrations-mcp-add-header")}
            description={t("integrations-mcp-add-secret-help")}
            control={
                <form
                    className="flex w-full flex-wrap items-center gap-2"
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        if (!name.trim() || !value) return;
                        setBusy(true);
                        void onAdd(kind, name.trim(), value)
                            .then(() => {
                                setName("");
                                setValue("");
                            })
                            .catch(() => {})
                            .finally(() => setBusy(false));
                    }}
                >
                    <input
                        aria-label={t("integrations-prov-name-label")}
                        placeholder={local ? "NAME" : "Authorization"}
                        value={name}
                        onChange={(ev) => setName(ev.target.value)}
                        className={`${fieldClass("md")} w-40 font-mono text-sm`}
                        spellCheck={false}
                    />
                    <input
                        aria-label={t("integrations-mcp-value")}
                        type="password"
                        autoComplete="new-password"
                        value={value}
                        onChange={(ev) => setValue(ev.target.value)}
                        className={`${fieldClass("md")} min-w-0 flex-1 basis-40 font-mono text-sm`}
                    />
                    <Button variant="primary" size="md" type="submit" busy={busy} disabled={!name.trim() || !value}>
                        {t("integrations-add")}
                    </Button>
                </form>
            }
        />
    );
}

/** MCP servers section for one scope. Views come from search params. */
export function McpSection({ scope }: { scope: Scope }) {
    const rec = useRecords<McpEntry>("agent.mcp", scope);
    const view = useSubView();
    useOAuthReturn();
    if (view.add === "catalog") return <McpCatalog rec={rec} view={view} />;
    if (view.add) return <McpSetup key={view.add} scope={scope} rec={rec} view={view} presetId={view.add} />;
    if (view.id) return <McpDetail key={view.id} scope={scope} rec={rec} view={view} id={view.id} />;
    return <McpList scope={scope} rec={rec} view={view} />;
}
