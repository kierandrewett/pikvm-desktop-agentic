/**
 * Model providers: list, catalogue, guided setup and detail pages (see common.tsx for the view model).
 *
 * Status comes from GET /api/models (what the runtime actually loaded) and from connection tests run in this session
 * (POST /api/providers/test), kept in the query cache per id. The detail page lists the provider's models
 * from GET /api/providers/:id/models, which also returns the models turned off on the entry (`disabledModels`), so
 * they can be turned back on. Nothing here loads on app start: the catalogue loads on the catalogue view, and one
 * provider's models load on its detail page.
 */
import { SubscriptionsSection } from "../subscriptions";
import {
    evaluateModelFeatures,
    Provider,
    providerApis,
    type ModelInfo,
    type ProviderModelsResponse,
    type ProviderPreset,
    type ProviderTestResult,
} from "@pikvm/chat-protocol";
import { ArrowClockwise, ArrowSquareOut, Cube, LockSimple, PlugsConnected, Plus } from "@pikvm/icons";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { z } from "zod";
import { apiUrl } from "../../../lib/config";
import { api } from "../../../lib/api";
import { keys } from "../../../lib/queries";
import { msg, translate } from "../../../l10n/runtime";
import { useT } from "../../../l10n/provider";
import { ModelBrowser, type BulkAction } from "../../model-browser";
import { ProviderLogo } from "../../model-picker/provider-logo";
import { ConfirmDialog } from "../../ui/dialog";
import { modelsQuery } from "../models";
import {
    CheckCard,
    errorMessage,
    InputRow,
    JsonBlock,
    makeId,
    useRecords,
    useConfirmMissing,
    useSubView,
    type Check,
    type RecordEntry,
    type Records,
    type SubView,
} from "./common";
import { GalleryTile, HealthLine, PresetGallery, useAgo, type GalleryItem, type Health } from "./parts";
import {
    AdvancedSection,
    Badge,
    Button,
    DangerZone,
    EmptyState,
    fromPairs,
    IconTile,
    KeyValueList,
    LinkRow,
    Notice,
    type Pairs,
    SecretRow,
    Select,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
    TextField,
    toPairs,
} from "../kit";

type ProviderEntry = z.input<typeof Provider>;
type Preset = ProviderPreset & { logo?: string; docs?: string };
type Catalog = { presets: Preset[]; custom: ProviderPreset };

const catalogQuery = queryOptions({
    queryKey: ["catalog", "providers"],
    queryFn: () => api.get<Catalog>("/providers/catalog"),
    staleTime: 10 * 60_000,
});

/** One provider's models, including turned-off ones. Loaded by the detail page only. */
const providerModelsQuery = (id: string, enabled: boolean) =>
    queryOptions({
        queryKey: ["providerModels", id],
        queryFn: () => api.get<ProviderModelsResponse>(`/providers/${encodeURIComponent(id)}/models`),
        enabled,
        staleTime: 30_000,
    });

const testKey = (id: string) => ["providerTest", id] as const;

/** Last connection test for an entry in this session. */
function useLastTest(id: string) {
    return (
        useQuery({
            queryKey: testKey(id),
            queryFn: () => null as ProviderTestResult | null,
            enabled: false,
            staleTime: Infinity,
        }).data ?? null
    );
}

async function runTest(id: string, value: ProviderEntry): Promise<ProviderTestResult> {
    return api.post<ProviderTestResult>("/providers/test", { id, value });
}

// Labels without vendor names: the API family after its vendor prefix.
const apiLabels: Record<string, string> = {
    completions: "Chat completions",
    responses: "Responses",
    messages: "Messages",
    "generative-ai": "Generative AI",
    vertex: "Vertex AI",
    "converse-stream": "Bedrock Converse",
    "models-list": "Models list (/v1/models)",
};
const technicalLabel = (id: string) => apiLabels[id.replace(/^[a-z]+-(?=[a-z])/, "")] ?? apiLabels[id] ?? id;

type DiscoveryType = NonNullable<ProviderEntry["discovery"]>["type"];
/** Discovery types come from the protocol schema, so this list never drifts from the server. */
const discoveryTypes = (Provider.shape.discovery.unwrap().shape.type.options as readonly DiscoveryType[]).slice();

/** The provider's own message when the error body is JSON, else the whole error (already free of secrets). */
const detailOf = (e: string | undefined) => /"message"\s*:\s*"([^"]+)"/.exec(e ?? "")?.[1] ?? e;

/** Plain explanation of a failed test, with the fix. */
function explain(r: ProviderTestResult): Extract<Check, { state: "error" }> {
    const detail = detailOf(r.error);
    const base = { state: "error" as const, detail, latencyMs: r.latencyMs };
    if (r.status === 401 || r.status === 403)
        return {
            ...base,
            title: translate("integrations-prov-err-key-title"),
            fix: translate("integrations-prov-err-key-fix"),
        };
    if (r.status === 404)
        return {
            ...base,
            title: translate("integrations-prov-err-404-title"),
            fix: translate("integrations-prov-err-404-fix"),
        };
    if (r.status === 429)
        return {
            ...base,
            title: translate("integrations-prov-err-429-title"),
            fix: translate("integrations-prov-err-429-fix"),
        };
    if (r.error?.startsWith("Could not reach")) {
        const timedOut = /timed? ?out|aborted/i.test(r.error);
        return {
            ...base,
            title: timedOut
                ? translate("integrations-prov-err-timeout-title")
                : translate("integrations-prov-err-unreachable-title"),
            fix: translate("integrations-prov-err-unreachable-fix"),
        };
    }
    if (r.error?.startsWith("Add a base URL"))
        return {
            state: "error",
            title: translate("integrations-prov-err-no-url-title"),
            fix: translate("integrations-prov-err-no-url-fix"),
        };
    return {
        ...base,
        title: translate("integrations-prov-err-generic-title"),
        fix: translate("integrations-prov-err-generic-fix"),
    };
}

const okCheck = (r: ProviderTestResult): Check => ({
    state: "ok",
    title: r.models.length
        ? translate("integrations-prov-connected-models", { count: r.models.length })
        : translate("integrations-prov-connected"),
    items: r.models,
    itemsLabel: translate("integrations-prov-models"),
    latencyMs: r.latencyMs,
});

/** One health line per provider, from this session's test or the live model list. */
function useHealth(rec: Records<ProviderEntry>): (e: RecordEntry<ProviderEntry>) => Health {
    const qc = useQueryClient();
    const models = useQuery(modelsQuery);
    const t = useT();
    return (e) => {
        if (e.entry.enabled === false) return { tone: "muted", text: t("integrations-health-off") };
        if (e.shadowed) return { tone: "warning", text: t("integrations-prov-health-shadowed") };
        if (e.owner === "user" && rec.lock === "policy")
            return { tone: "warning", text: t("integrations-prov-health-paused") };
        const test = qc.getQueryData<ProviderTestResult | null>(testKey(e.id));
        if (test && !test.ok) return { tone: "error", text: explain(test).title };
        if (models.isLoading) return { tone: "busy", text: t("integrations-health-checking") };
        const n = models.data?.models.filter((m) => m.provider === e.id).length ?? 0;
        const err = models.data?.errors.find((x) => x.provider === e.id);
        if (err) return { tone: "error", text: err.message };
        // An account-wide listing failure (the runtime could not start) matters only while nothing is listed.
        if (!n && models.data?.errors.some((x) => x.provider === "*"))
            return { tone: "error", text: t("integrations-prov-health-list-failed") };
        const off = e.entry.disabledModels?.length ?? 0;
        if (n || off)
            return {
                tone: "ok",
                text: off
                    ? t("integrations-prov-health-models-off", { count: n, off })
                    : t("integrations-prov-health-models", { count: n }),
            };
        if (test?.ok) return { tone: "ok", text: t("integrations-prov-health-found", { count: test.models.length }) };
        return { tone: "muted", text: t("integrations-health-unchecked") };
    };
}

function useLogo(id: string): string | undefined {
    const cat = useQuery({ ...catalogQuery, enabled: false });
    const models = useQuery({ ...modelsQuery, enabled: false });
    return (
        cat.data?.presets.find((p) => p.id === id)?.logo ??
        models.data?.models.find((m) => m.provider === id)?.logo ??
        apiUrl(`/models/logos/${id}.svg`)
    );
}

function ProviderIcon({ id, name, size = "md" }: { id: string; name: string; size?: "md" | "lg" }) {
    const src = useLogo(id);
    return (
        <IconTile size={size}>
            <ProviderLogo src={src} name={name} size={20} />
        </IconTile>
    );
}

/** Name without loading the catalogue: the entry label, a known preset, the name the server lists, else the id. */
function nameOf(id: string, e: ProviderEntry, presets: Preset[] | undefined, listed?: string): string {
    return e.label || presets?.find((p) => p.id === id)?.name || listed || id;
}

/** The provider name from the model list the page already has (no extra request). */
function useListedName(id: string): string | undefined {
    const models = useQuery({ ...modelsQuery, enabled: false });
    const name = models.data?.models.find((m) => m.provider === id)?.providerName;
    return name && name !== id ? name : undefined;
}

// List

function ProviderRow({
    rec,
    e,
    view,
    health,
}: {
    rec: Records<ProviderEntry>;
    e: RecordEntry<ProviderEntry>;
    view: SubView;
    health: Health;
}) {
    const t = useT();
    const name = nameOf(e.id, e.entry, undefined, useListedName(e.id));
    const [error, setError] = useState<string | null>(null);
    return (
        <LinkRow
            id={`provider-${e.owner}-${e.id}`}
            icon={<ProviderIcon id={e.id} name={name} />}
            label={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {name}
                    {e.owner === "global" && (
                        <Badge>
                            <LockSimple aria-hidden /> {t("integrations-managed")}
                        </Badge>
                    )}
                </span>
            }
            description={error ? <span className="text-danger">{error}</span> : <HealthLine health={health} />}
            onClick={() => view.go({ id: e.id })}
            trailing={
                <Switch
                    checked={e.entry.enabled !== false}
                    disabled={!e.editable}
                    label={t("integrations-switch-on", { name })}
                    onChange={(on) => {
                        setError(null);
                        void rec.save(e.id, { ...e.entry, enabled: on }).catch((err) => setError(errorMessage(err)));
                    }}
                />
            }
        />
    );
}

function ProviderList({ rec, view }: { rec: Records<ProviderEntry>; view: SubView }) {
    const t = useT();
    const health = useHealth(rec);
    const global = rec.entries.filter((e) => e.owner === "global");
    const own = rec.entries.filter((e) => e.owner === "user");
    const canAdd = rec.writable;
    const rows = (list: RecordEntry<ProviderEntry>[]) =>
        list.map((e) => (
            <ProviderRow key={`${e.owner}:${e.id}`} rec={rec} e={e} view={view} health={health(e)} />
        ));

    return (
        <SettingsPage
            title={t("integrations-prov-title")}
            actions={[
                canAdd && {
                        label: t("integrations-prov-add"),
                        icon: <Plus />,
                        onSelect: () => view.go({ add: "catalog" }),
                    },
            ]}
        >
            {rec.lock === "policy" && (
                <Notice tone={own.length ? "warning" : "neutral"}>
                    {own.length ? t("integrations-prov-policy-paused") : t("integrations-prov-policy-blocked")}
                </Notice>
            )}
            {global.length > 0 && (
                <SettingsSection
                    title={t("integrations-prov-org-title")}
                    description={t("integrations-prov-org-description")}
                >
                    <SettingsCard>{rows(global)}</SettingsCard>
                </SettingsSection>
            )}
            <SettingsSection
                title={global.length ? t("integrations-prov-yours") : undefined}
            >
                <SettingsCard>
                    {rec.loading && <EmptyState loading>{t("integrations-prov-loading")}</EmptyState>}
                    {!rec.loading && own.length === 0 && (
                        <EmptyState
                            size="block"
                            icon={Cube}
                            title={t("integrations-prov-empty-user")}
                            description={
                                !canAdd
                                    ? t("integrations-prov-empty-off")
                                    : t("integrations-prov-empty-user-description")
                            }
                            action={
                                canAdd ? (
                                    <Button variant="primary" onClick={() => view.go({ add: "catalog" })}>
                                        {t("integrations-prov-add")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    )}
                    {rows(own)}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}

// Catalogue

const GROUPS = [
    { id: "cloud", title: msg("integrations-prov-group-cloud") },
    { id: "router", title: msg("integrations-prov-group-router") },
    { id: "local", title: msg("integrations-prov-group-local") },
];

function Catalogue({ rec, view }: { rec: Records<ProviderEntry>; view: SubView }) {
    const t = useT();
    const cat = useQuery(catalogQuery);
    if (cat.isLoading) return <Notice>{t("integrations-prov-catalogue-loading")}</Notice>;
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
    const added = new Set(rec.entries.map((e) => e.id));
    const items: GalleryItem[] = cat.data.presets.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        icon: <ProviderIcon id={p.id} name={p.name} />,
        added: added.has(p.id),
        group: p.kind,
    }));
    const custom = cat.data.custom;
    return (
        <>
            <SubscriptionsSection renderIcon={(id, name) => <ProviderIcon id={id} name={name} />} />
            <PresetGallery
            items={items}
            groups={GROUPS.map((g) => ({ id: g.id, title: t(g.title) }))}
            noun="providers"
            onPick={(item) => view.go(item.added ? { id: item.id } : { add: item.id })}
            footer={
                <SettingsSection title={t("integrations-prov-something-else")}>
                    <GalleryTile
                        item={{
                            id: "custom",
                            name: custom.name,
                            description: custom.description,
                            icon: (
                                <IconTile>
                                    <Plus aria-hidden />
                                </IconTile>
                            ),
                        }}
                        onPick={() => view.go({ add: "custom" })}
                    />
                </SettingsSection>
            }
        />
        </>
    );
}

function ProviderCatalog({ rec, view }: { rec: Records<ProviderEntry>; view: SubView }) {
    const t = useT();
    return (
        <SettingsPage
            title={t("integrations-prov-add-title")}
            back={{ label: t("integrations-prov-title"), onClick: () => view.go({}) }}
        >
            <Catalogue rec={rec} view={view} />
        </SettingsPage>
    );
}

// Setup

/** Fill a preset's provider entry from the values the user typed. */
function buildEntry(
    preset: ProviderPreset,
    values: Record<number, string>,
    extra: { label?: string; api?: string },
): ProviderEntry {
    const p: ProviderEntry = { ...(preset.provider as ProviderEntry), enabled: true };
    preset.inputs.forEach((input, i) => {
        const v = (values[i] ?? "").trim() || input.defaultValue || "";
        if (!v) return;
        if (input.target.kind === "apiKey") p.apiKey = v;
        if (input.target.kind === "baseUrl") p.baseUrl = v.replace(/\/+$/, "");
        if (input.target.kind === "header")
            p.headers = { ...p.headers, [input.target.name]: `${input.target.prefix ?? ""}${v}` };
    });
    if (extra.label) p.label = extra.label;
    if (extra.api) p.api = extra.api as ProviderEntry["api"];
    return JSON.parse(JSON.stringify(p)) as ProviderEntry;
}

function ProviderSetup({
    rec,
    view,
    presetId,
}: {
    rec: Records<ProviderEntry>;
    view: SubView;
    presetId: string;
}) {
    const t = useT();
    const qc = useQueryClient();
    const cat = useQuery(catalogQuery);
    const preset: Preset | undefined =
        presetId === "custom" ? cat.data?.custom : cat.data?.presets.find((p) => p.id === presetId);
    const custom = presetId === "custom";
    const [values, setValues] = useState<Record<number, string>>({});
    const [name, setName] = useState("");
    const [apiType, setApiType] = useState<string>(providerApis[0]);
    const [check, setCheck] = useState<Check>({ state: "idle" });
    const [missing, setMissing] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);
    const back = { label: t("integrations-prov-add-title"), onClick: () => view.go({ add: "catalog" }) };

    if (cat.isLoading)
        return (
            <SettingsPage title={t("integrations-connect")} back={back}>
                <Notice>{t("integrations-loading-dots")}</Notice>
            </SettingsPage>
        );
    if (cat.isError)
        return (
            <SettingsPage title={t("integrations-connect")} back={back}>
                <Notice
                    tone="danger"
                    action={
                        <Button busy={cat.isFetching} onClick={() => void cat.refetch()}>
                            {t("integrations-try-again")}
                        </Button>
                    }
                >
                    {t("integrations-prov-catalogue-failed-short")}
                </Notice>
            </SettingsPage>
        );
    if (!preset) {
        return (
            <SettingsPage title={t("integrations-not-found")} back={back}>
                <Notice>{t("integrations-prov-not-in-catalogue")}</Notice>
            </SettingsPage>
        );
    }

    const taken = rec.entries.map((e) => e.id);
    const id = custom ? makeId(name || hostOf(values) || "custom", taken) : preset.id;
    const entry = () => buildEntry(preset, values, custom ? { label: name.trim() || undefined, api: apiType } : {});

    const validate = () => {
        const gaps = preset.inputs
            .map((inp, i) => (!inp.optional && !inp.defaultValue && !(values[i] ?? "").trim() ? i : -1))
            .filter((i) => i >= 0);
        setMissing(gaps);
        return gaps.length === 0;
    };

    const save = async (e: ProviderEntry) => {
        setSaving(true);
        try {
            await rec.save(id, e);
            view.go({ id });
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-could-not-save"), detail: errorMessage(err) });
        } finally {
            setSaving(false);
        }
    };

    const connect = async () => {
        if (!validate()) return;
        const e = entry();
        setCheck({ state: "running", text: t("integrations-prov-checking-named", { name: preset.name }) });
        try {
            const r = await runTest(id, e);
            qc.setQueryData(testKey(id), r);
            if (!r.ok) return setCheck(explain(r));
            setCheck(okCheck(r));
            await save(e);
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-check-failed"), detail: errorMessage(err) });
        }
    };

    if (!custom && taken.includes(preset.id)) {
        return (
            <SettingsPage title={t("integrations-connect-named", { name: preset.name })} back={back}>
                <Notice action={<Button onClick={() => view.go({ id: preset.id })}>{t("integrations-open")}</Button>}>
                    {t("integrations-prov-already-connected", { name: preset.name })}
                </Notice>
            </SettingsPage>
        );
    }

    const busy = check.state === "running" || saving;
    return (
        <SettingsPage
            title={
                custom ? t("integrations-prov-connect-custom") : t("integrations-connect-named", { name: preset.name })
            }
            back={back}
        >
            <SettingsSection>
                <SettingsCard>
                    <SettingRow
                        icon={<ProviderIcon id={preset.id} name={preset.name} size="lg" />}
                        label={preset.name}
                        description={preset.description}
                        control={
                            "docs" in preset && preset.docs ? (
                                <a
                                    href={preset.docs}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-sm text-accent-text hover-device:hover:underline"
                                >
                                    {t("integrations-docs")} <ArrowSquareOut aria-hidden className="size-3.5" />
                                </a>
                            ) : undefined
                        }
                    />
                </SettingsCard>
            </SettingsSection>
            <form
                className="contents"
                onSubmit={(ev) => {
                    ev.preventDefault();
                    void connect();
                }}
            >
                <SettingsSection
                    title={t("integrations-details")}
                    description={t("integrations-prov-details-user")}
                >
                    <SettingsCard>
                        {custom && (
                            <InputRow
                                input={{
                                    target: { kind: "arg", placeholder: "" },
                                    label: t("integrations-prov-name-label"),
                                    help: t("integrations-prov-name-help"),
                                    optional: true,
                                }}
                                value={name}
                                onChange={setName}
                            />
                        )}
                        {preset.inputs.map((input, i) => (
                            <InputRow
                                key={i}
                                input={input}
                                value={values[i] ?? ""}
                                onChange={(v) => setValues((s) => ({ ...s, [i]: v }))}
                                error={
                                    missing.includes(i)
                                        ? t("integrations-enter-field", { label: input.label.toLowerCase() })
                                        : null
                                }
                            />
                        ))}
                        {custom && (
                            <SettingRow
                                label={t("integrations-prov-api-type")}
                                description={t("integrations-prov-api-type-help")}
                                control={
                                    <Select
                                        label={t("integrations-prov-api-type")}
                                        value={apiType}
                                        options={providerApis.map((a) => ({ value: a, label: technicalLabel(a) }))}
                                        onChange={setApiType}
                                    />
                                }
                            />
                        )}
                        {preset.inputs.length === 0 && !custom && (
                            <EmptyState>{t("integrations-prov-nothing-to-fill")}</EmptyState>
                        )}
                    </SettingsCard>
                    <CheckCard check={check} />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button onClick={() => validate() && void save(entry())} disabled={busy}>
                            {t("integrations-save-untested")}
                        </Button>
                        <Button variant="primary" size="md" type="submit" busy={busy}>
                            {check.state === "error"
                                ? t("integrations-test-again")
                                : t("integrations-prov-test-connect")}
                        </Button>
                    </div>
                </SettingsSection>
            </form>
        </SettingsPage>
    );
}

function hostOf(values: Record<number, string>): string | undefined {
    for (const v of Object.values(values)) {
        try {
            return new URL(v).hostname.replace(/^www\./, "");
        } catch {
            // not a URL
        }
    }
    return undefined;
}

// Detail

function ProviderDetail({
    rec,
    view,
    id,
}: {
    rec: Records<ProviderEntry>;
    view: SubView;
    id: string;
}) {
    const t = useT();
    const qc = useQueryClient();
    const cat = useQuery(catalogQuery);
    const health = useHealth(rec);
    const e = rec.get(id);
    const listedName = useListedName(id);
    const confirming = useConfirmMissing(!e, rec.loading);
    const [check, setCheck] = useState<Check>({ state: "idle" });
    const [confirm, setConfirm] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const back = { label: t("integrations-prov-title"), onClick: () => view.go({}) };

    if (!e) {
        return (
            <SettingsPage title={confirming ? t("integrations-loading") : t("integrations-not-found")} back={back}>
                <Notice>{confirming ? t("integrations-loading-dots") : t("integrations-prov-gone")}</Notice>
            </SettingsPage>
        );
    }

    const entry = e.entry;
    const preset = cat.data?.presets.find((p) => p.id === id);
    const name = nameOf(id, entry, cat.data?.presets, listedName);
    const editable = e.editable;
    const keyUrl = preset?.inputs.find((i) => i.target.kind === "apiKey")?.url;
    const update = async (patch: Partial<ProviderEntry>) => {
        setSaveError(null);
        try {
            await rec.save(id, JSON.parse(JSON.stringify({ ...entry, ...patch })) as ProviderEntry);
        } catch (err) {
            setSaveError(errorMessage(err));
            throw err;
        }
    };
    const test = async () => {
        setCheck({ state: "running", text: t("integrations-checking") });
        try {
            const r = await runTest(id, entry);
            qc.setQueryData(testKey(id), r);
            setCheck(r.ok ? okCheck(r) : explain(r));
        } catch (err) {
            setCheck({ state: "error", title: t("integrations-check-failed"), detail: errorMessage(err) });
        }
    };

    return (
        <SettingsPage
            title={name}
            back={back}
            actions={[
                {
                    label: t("integrations-test-connection"),
                    icon: <PlugsConnected />,
                    busy: check.state === "running",
                    onSelect: () => void test(),
                },
            ]}
        >
            <SettingsSection>
                {e.owner === "global" && <Notice>{t("integrations-prov-managed-note")}</Notice>}
                {e.shadowed && <Notice tone="warning">{t("integrations-prov-shadowed-note")}</Notice>}
                {saveError && <Notice tone="danger">{saveError}</Notice>}
                <SettingsCard>
                    <SettingRow
                        icon={<ProviderIcon id={id} name={name} size="lg" />}
                        label={t("integrations-prov-use")}
                        description={<HealthLine health={health(e)} />}
                        control={
                            <Switch
                                checked={entry.enabled !== false}
                                disabled={!editable}
                                label={t("integrations-switch-on", { name })}
                                onChange={(on) => void update({ enabled: on }).catch(() => {})}
                            />
                        }
                    />
                </SettingsCard>
                <CheckCard check={check} />
            </SettingsSection>
            <SettingsSection title={t("integrations-connection")}>
                <SettingsCard>
                    {editable ? (
                        <SecretRow
                            id="provider-key"
                            label={t("integrations-api-key")}
                            description={
                                keyUrl ? (
                                    <a
                                        href={keyUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-accent-text hover-device:hover:underline"
                                    >
                                        {t("integrations-input-get-key")}{" "}
                                        <ArrowSquareOut aria-hidden className="size-3.5" />
                                    </a>
                                ) : (
                                    t("integrations-prov-key-stored")
                                )
                            }
                            isSet={!!entry.apiKey}
                            editable={editable}
                            optional
                            onSave={(v) => update({ apiKey: v })}
                        />
                    ) : (
                        <SettingRow
                            label={t("integrations-api-key")}
                            control={<span className="text-sm text-secondary">{t("integrations-kept-on-server")}</span>}
                        />
                    )}
                    <SettingRow
                        label={t("integrations-address")}
                        control={
                            <span className="truncate font-mono text-xs text-secondary">
                                {entry.baseUrl || t("integrations-prov-builtin")}
                            </span>
                        }
                    />
                </SettingsCard>
            </SettingsSection>
            <ProviderModels id={id} name={name} entry={entry} editable={editable} update={update} />
            {editable && (
                <AdvancedSection label={t("integrations-advanced")}>
                    <SettingsCard>
                        <SettingRow
                            label={t("integrations-base-url")}
                            description={t("integrations-prov-base-url-help")}
                            control={
                                <TextField
                                    value={entry.baseUrl ?? ""}
                                    onCommit={(v) => void update({ baseUrl: v || undefined }).catch(() => {})}
                                    label={t("integrations-base-url")}
                                    placeholder="https://api.example.com/v1"
                                    mono
                                    className="w-64"
                                />
                            }
                        />
                        <SettingRow
                            label={t("integrations-prov-api-type")}
                            control={
                                <Select
                                    label={t("integrations-prov-api-type")}
                                    value={entry.api ?? ""}
                                    options={[
                                        { value: "", label: t("integrations-default") },
                                        ...providerApis.map((a) => ({ value: a, label: technicalLabel(a) })),
                                    ]}
                                    onChange={(v) =>
                                        void update({ api: (v || undefined) as ProviderEntry["api"] }).catch(() => {})
                                    }
                                />
                            }
                        />
                        <SettingRow
                            label={t("integrations-prov-discovery")}
                            description={t("integrations-prov-discovery-help")}
                            control={
                                <Select
                                    label={t("integrations-prov-discovery")}
                                    value={entry.discovery?.type ?? ""}
                                    options={[
                                        { value: "", label: t("integrations-none") },
                                        ...discoveryTypes.map((d) => ({ value: d, label: technicalLabel(d) })),
                                    ]}
                                    onChange={(v) =>
                                        void update({ discovery: v ? { type: v as DiscoveryType } : undefined }).catch(
                                            () => {},
                                        )
                                    }
                                />
                            }
                        />
                        <HeadersRow headers={entry.headers} onSave={(h) => update({ headers: h })} />
                    </SettingsCard>
                    <JsonBlock value={{ [id]: entry }} />
                </AdvancedSection>
            )}
            {editable && (
                <DangerZone>
                    <SettingRow
                        label={t("integrations-prov-remove")}
                        description={t("integrations-prov-remove-help")}
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
                title={t("integrations-remove-named", { name })}
                description={t("integrations-prov-remove-confirm")}
                confirmLabel={t("integrations-remove")}
                danger
                onConfirm={() =>
                    void rec
                        .remove(id)
                        .then(() => view.go({}))
                        .catch((err) => setSaveError(errorMessage(err)))
                }
            />
        </SettingsPage>
    );
}

/** Models from a connection test only: ids, no metadata, so no capabilities are claimed. */
function idsAsModels(id: string, ids: string[]): ModelInfo[] {
    return ids.map((modelId) => {
        const capabilities = { reasoning: false, efforts: [], input: [], toolCall: false };
        return {
            id: `${id}/${modelId}`,
            provider: id,
            providerName: id,
            modelId,
            name: modelId,
            logo: apiUrl(`/models/logos/${id}.svg`),
            ...capabilities,
            legacy: false,
            features: evaluateModelFeatures({ ...capabilities, id: `${id}/${modelId}` }, {}),
        };
    });
}

/**
 * The provider's models with one switch each. Turned-off models are stored on the entry (`disabledModels`) and
 * hidden from the model picker; models the model policy blocks are marked and cannot be turned on here.
 */
function ProviderModels({
    id,
    name,
    entry,
    editable,
    update,
}: {
    id: string;
    name: string;
    entry: ProviderEntry;
    editable: boolean;
    update: (patch: Partial<ProviderEntry>) => Promise<void>;
}) {
    const t = useT();
    const ago = useAgo();
    const qc = useQueryClient();
    const on = entry.enabled !== false;
    const query = useQuery(providerModelsQuery(id, on));
    const lastTest = useLastTest(id);
    const [refresh, setRefresh] = useState<{ busy: boolean; error?: string }>({ busy: false });
    const disabled = useMemo(() => new Set(entry.disabledModels ?? []), [entry.disabledModels]);
    const blocked = useMemo(() => new Set(query.data?.blocked ?? []), [query.data]);
    const fromTest = !query.data?.models.length && !!lastTest?.ok;
    const models = useMemo(
        () => (fromTest ? idsAsModels(id, lastTest!.models) : (query.data?.models ?? [])),
        [fromTest, lastTest, query.data, id],
    );

    const setOff = (ids: string[], off: boolean) => {
        const next = new Set(disabled);
        for (const m of ids) {
            if (off) next.add(m);
            else next.delete(m);
        }
        return update({ disabledModels: next.size ? [...next].sort() : undefined }).catch(() => {});
    };
    const toggle = (m: ModelInfo) => void setOff([m.modelId], !disabled.has(m.modelId));

    const doRefresh = async () => {
        setRefresh({ busy: true });
        try {
            const r = await api.post<{ ok: boolean; error?: string }>("/models/refresh", {});
            setRefresh({ busy: false, error: r.ok ? undefined : r.error });
        } catch (err) {
            setRefresh({ busy: false, error: errorMessage(err) });
        }
        void qc.invalidateQueries({ queryKey: ["providerModels"] });
        void qc.invalidateQueries({ queryKey: keys.models });
    };

    const bulk: BulkAction[] = editable
        ? [
              {
                  id: "on",
                  label: (n) => t("integrations-prov-turn-on", { count: n }),
                  appliesTo: (m) => disabled.has(m.modelId),
                  run: (list) =>
                      setOff(
                          list.map((m) => m.modelId),
                          false,
                      ),
              },
              {
                  id: "off",
                  label: (n) => t("integrations-prov-turn-off", { count: n }),
                  appliesTo: (m) => !disabled.has(m.modelId),
                  run: (list) =>
                      setOff(
                          list.map((m) => m.modelId),
                          true,
                      ),
              },
          ]
        : [];

    const total = models.length;
    const offCount = models.filter((m) => disabled.has(m.modelId)).length;
    const checked = ago(query.data?.checkedAt);
    const summary = !on
        ? t("integrations-prov-models-off")
        : total
          ? [
                offCount
                    ? t("integrations-prov-models-total-off", { count: total, off: offCount })
                    : t("integrations-prov-models-total", { count: total }),
                checked && !fromTest ? t("integrations-prov-models-listed", { when: checked }) : undefined,
                fromTest ? t("integrations-prov-models-from-test") : undefined,
            ]
                .filter(Boolean)
                .join(" ")
          : undefined;

    return (
        <SettingsSection
            title={t("integrations-prov-models")}
            description={
                <>
                    {summary ?? t("integrations-prov-models-default")}
                    {refresh.error && (
                        <span className="block text-danger">
                            {t("integrations-prov-refresh-failed", { error: refresh.error })}
                        </span>
                    )}
                    {query.data?.current === false && (
                        <span className="block">{t("integrations-prov-models-stale")}</span>
                    )}
                </>
            }
            action={
                on && (
                    <Button onClick={() => void doRefresh()} busy={refresh.busy}>
                        <ArrowClockwise aria-hidden /> {t("integrations-refresh")}
                    </Button>
                )
            }
        >
            <ModelBrowser
                models={on ? models : []}
                loading={on && query.isLoading && !lastTest?.ok}
                error={query.data?.error && !models.length ? new Error(query.data.error) : query.error}
                onRetry={() => void doRefresh()}
                favorites={false}
                height={440}
                label={t("integrations-prov-models-label", { name })}
                hoverCard={false}
                rowState={(m) => ({
                    enabled: !disabled.has(m.modelId),
                    changed: disabled.has(m.modelId),
                    muted: disabled.has(m.modelId) || blocked.has(m.modelId),
                })}
                onToggle={editable ? toggle : undefined}
                bulkActions={bulk}
                renderRowEnd={(m) => (
                    <span className="flex items-center gap-2">
                        {blocked.has(m.modelId) && <Badge tone="warning">{t("integrations-prov-blocked")}</Badge>}
                        {editable ? (
                            <Switch
                                checked={!disabled.has(m.modelId)}
                                label={t("integrations-switch-on", { name: m.name })}
                                onChange={() => toggle(m)}
                            />
                        ) : (
                            disabled.has(m.modelId) && <Badge>{t("integrations-health-off")}</Badge>
                        )}
                    </span>
                )}
                emptyState={
                    <EmptyState
                        size="block"
                        icon={Cube}
                        title={on ? t("integrations-prov-no-models") : t("integrations-prov-is-off")}
                        description={on ? t("integrations-prov-no-models-help") : t("integrations-prov-is-off-help")}
                    />
                }
            />
        </SettingsSection>
    );
}

function HeadersRow({
    headers,
    onSave,
}: {
    headers: Record<string, string> | undefined;
    onSave: (h: Record<string, string> | undefined) => Promise<void>;
}) {
    const t = useT();
    const initial = toPairs(headers);
    const [draft, setDraft] = useState<Pairs>(initial);
    const [busy, setBusy] = useState(false);
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
    return (
        <SettingRow
            stack
            label={t("integrations-prov-headers")}
            description={t("integrations-prov-headers-help")}
            control={
                <div className="flex w-full flex-col gap-2">
                    <KeyValueList
                        label={t("integrations-prov-headers-list")}
                        value={draft}
                        onChange={setDraft}
                        secret
                    />
                    {dirty && (
                        <div className="flex justify-end gap-2">
                            <Button onClick={() => setDraft(initial)}>{t("integrations-cancel")}</Button>
                            <Button
                                variant="primary"
                                size="md"
                                busy={busy}
                                onClick={() => {
                                    setBusy(true);
                                    void onSave(fromPairs(draft))
                                        .catch(() => {})
                                        .finally(() => setBusy(false));
                                }}
                            >
                                {t("integrations-prov-headers-save")}
                            </Button>
                        </div>
                    )}
                </div>
            }
        />
    );
}

/** The model providers section. Views come from search params. */
export function ProvidersSection() {
    const rec = useRecords<ProviderEntry>("agent.providers");
    const view = useSubView();
    if (view.add === "catalog") return <ProviderCatalog rec={rec} view={view} />;
    if (view.add) return <ProviderSetup key={view.add} rec={rec} view={view} presetId={view.add} />;
    if (view.id) return <ProviderDetail key={view.id} rec={rec} view={view} id={view.id} />;
    return <ProviderList rec={rec} view={view} />;
}
