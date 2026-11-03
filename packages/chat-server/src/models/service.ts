/**
 * The models a user can pick. The runtime is the source of truth for what is available with the
 * user's effective providers; a short-lived process lists them (about 4 s). Provider switches filter
 * the list; models.dev adds names, logos, limits and costs.
 *
 * Caching is stale-while-revalidate: the last listing per user is kept in memory and on disk
 * (users/<id>/cache/runtime-info.json). A request always gets the cached listing at once; when it is
 * older than 10 minutes (discovery-based providers add models) or was made for a different config
 * (providers or MCP changed), a refresh runs in the background, and when it lands the user's sockets
 * get `chat.models.updated` so clients refetch. Only a user with no listing waits for the process.
 * Bootstrap does not start discovery.
 */
import type {
    ModelInfo,
    ModelsResponse,
    ProviderModelsResponse,
    ThinkingEffort,
} from "@pikvm/chat-protocol";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMPUTER_ARGS, renderAgentConfig, writeAgentConfig } from "../agent/config.ts";
import { RpcClient } from "../agent/rpc.ts";
import { buildSpawn, locateRuntime } from "../agent/launch.ts";
import { agentBaseUrl } from "../env.ts";
import { paths } from "../paths.ts";
import { resolveSetting, setting } from "../settings/store.ts";
import type { Provider } from "@pikvm/chat-protocol";
import { catalog, setCatalogListener, type DevModel } from "./catalog.ts";
import { labFor, Matcher } from "./match.ts";
import { modelFeatureResolver } from "./features.ts";
import { modelSwitch } from "./policy.ts";

interface RuntimeModel {
    id: string;
    name: string;
    provider: string;
    baseUrl?: string;
    reasoning?: boolean;
    input?: ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    thinking?: { efforts?: string[] };
}

export interface RuntimeCommand {
    name: string;
    source: string;
    description?: string;
    input?: { hint?: string };
}

interface RuntimeInfo {
    models: RuntimeModel[];
    commands: RuntimeCommand[];
}

const TTL_MS = 10 * 60_000;

interface CachedInfo {
    /** Rendered-config hash the listing was made for. */
    hash: string;
    at: number;
    info: RuntimeInfo;
}

const runtimeCache = new Map<string, CachedInfo>();
const inflight = new Map<string, { commands: boolean; hash: string; promise: Promise<RuntimeInfo> }>();
const commandCache = new Map<string, { hash: string; at: number; commands: RuntimeCommand[] }>();
const failed = new Map<string, { hash: string; at: number; error: Error }>();
const RETRY_MS = 30_000;

let onRuntimeChange: ((userId: string) => void) | undefined;
/** Called after a background refresh changed a user's listing (the HTTP layer tells their sockets). */
export function setRuntimeListener(fn: (userId: string) => void): void {
    onRuntimeChange = fn;
}

function readDisk(userId: string): CachedInfo | undefined {
    try {
        const c = JSON.parse(readFileSync(paths.user(userId).runtimeInfo, "utf8")) as CachedInfo;
        return typeof c.hash === "string" &&
            Number.isFinite(c.at) &&
            Array.isArray(c.info?.models) &&
            Array.isArray(c.info?.commands)
            ? c
            : undefined;
    } catch {
        return undefined;
    }
}

function writeDisk(userId: string, c: CachedInfo): void {
    const file = paths.user(userId).runtimeInfo;
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
    } catch (err) {
        console.warn(`[models] could not save the listing for ${userId}: ${(err as Error).message}`);
    }
}

/** The last listing for a user (memory, then disk), whatever its age or config. */
function cachedInfo(userId: string): CachedInfo | undefined {
    let c = runtimeCache.get(userId);
    if (!c) {
        c = readDisk(userId);
        if (c) runtimeCache.set(userId, c);
    }
    return c;
}

/** One discovery process per user. Command discovery starts only for an explicit commands request. */
function refresh(userId: string, includeCommands = false): Promise<RuntimeInfo> {
    const cfg = renderAgentConfig(userId, agentBaseUrl());
    const running = inflight.get(userId);
    if (running) {
        // A run for an older config is discarded when it lands, so a change made meanwhile needs its own run.
        const next = () => refresh(userId, includeCommands || running.commands);
        if (running.hash !== cfg.hash) return running.promise.then(next, next);
        if (!includeCommands || running.commands) return running.promise;
        return running.promise.then(() => refresh(userId, true));
    }
    const failure = failed.get(userId);
    if (failure?.hash === cfg.hash && Date.now() - failure.at < RETRY_MS) return Promise.reject(failure.error);
    writeAgentConfig(userId, agentBaseUrl());

    let superseded = false;
    const p = (async () => {
        locateRuntime();
        const ws = paths.user(userId).workspace;
        mkdirSync(ws, { recursive: true });
        const rpc = new RpcClient(
            buildSpawn(userId, ws, ["--mode", "rpc-ui", "--no-session", "--no-title", ...COMPUTER_ARGS]),
            `${userId}/models`,
        );
        try {
            await rpc.ready();
            const { models } = await rpc.request<{ models: RuntimeModel[] }>("get_available_models");
            const commands = includeCommands
                ? (await rpc.request<{ commands: RuntimeCommand[] }>("get_available_commands")).commands
                : (commandCache.get(userId)?.commands ?? []);
            const info = { models, commands };
            // A settings change during discovery must not overwrite a newer configuration's listing. The newer
            // configuration gets its own run once this one is cleared (see the finally below).
            if (renderAgentConfig(userId, agentBaseUrl()).hash !== cfg.hash) {
                superseded = true;
                return info;
            }
            if (includeCommands) commandCache.set(userId, { hash: cfg.hash, at: Date.now(), commands });
            failed.delete(userId);
            const prev = runtimeCache.get(userId);
            const next = { hash: cfg.hash, at: Date.now(), info };
            const changed = !prev || prev.hash !== next.hash || JSON.stringify(prev.info) !== JSON.stringify(info);
            // Keep the old object when nothing changed, so the built model list stays memoised.
            runtimeCache.set(userId, changed ? next : { ...prev!, at: next.at });
            writeDisk(userId, changed ? next : { ...prev!, at: next.at });
            if (changed && prev) onRuntimeChange?.(userId);
            return changed ? info : prev!.info;
        } finally {
            await rpc.close();
        }
    })()
        .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            failed.set(userId, { hash: cfg.hash, at: Date.now(), error: failure });
            throw failure;
        })
        .finally(() => {
            inflight.delete(userId);
            // Config changes without a request (for example embeddings becoming ready) would otherwise leave the
            // listing on the old config until the TTL. This repeats only while the config keeps changing.
            if (superseded)
                void refresh(userId, includeCommands).catch((err) =>
                    console.warn(`[models] follow-up refresh for ${userId} failed: ${(err as Error).message}`),
                );
        });
    inflight.set(userId, { commands: includeCommands, hash: cfg.hash, promise: p });
    return p;
}

/**
 * The runtime's models and commands for a user. Returns the cached listing at once and refreshes it in
 * the background when it is stale; `current` is false when the listing was made for an older config.
 */
export async function runtimeListing(userId: string): Promise<{ info: RuntimeInfo; current: boolean }> {
    const hit = cachedInfo(userId);
    if (!hit) {
        const info = await refresh(userId);
        return { info, current: cachedInfo(userId)?.hash === renderAgentConfig(userId, agentBaseUrl()).hash };
    }
    const current = hit.hash === renderAgentConfig(userId, agentBaseUrl()).hash;
    if (!current || Date.now() - hit.at >= TTL_MS) {
        void refresh(userId).catch((err) =>
            console.warn(`[models] background refresh for ${userId} failed: ${(err as Error).message}`),
        );
    }
    return { info: hit.info, current };
}

/** Commands are requested by the slash menu, never by bootstrap or model listing. */
export async function runtimeInfo(userId: string): Promise<RuntimeInfo> {
    const hash = renderAgentConfig(userId, agentBaseUrl()).hash;
    const commands = commandCache.get(userId);
    if (commands?.hash === hash && Date.now() - commands.at < TTL_MS) {
        return { models: cachedInfo(userId)?.info.models ?? [], commands: commands.commands };
    }
    return refresh(userId, true);
}

let matcher: Matcher | undefined;
setCatalogListener(() => (matcher = undefined));
function getMatcher(): Matcher {
    matcher ??= new Matcher(catalog());
    return matcher;
}

const EFFORTS: ThinkingEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function inputs(rt: RuntimeModel, dev?: DevModel): ModelInfo["input"] {
    const set = new Set<string>([...(rt.input ?? ["text"]), ...(dev?.modalities?.input ?? [])]);
    return [...set].filter((x): x is ModelInfo["input"][number] =>
        ["text", "image", "audio", "video", "pdf"].includes(x),
    );
}

/** Legacy = released more than a year before the newest model of the same provider. */
function markLegacy(models: ModelInfo[]): void {
    const newest = new Map<string, number>();
    for (const m of models) {
        const t = m.releaseDate ? Date.parse(m.releaseDate) : NaN;
        if (!Number.isNaN(t)) newest.set(m.provider, Math.max(newest.get(m.provider) ?? 0, t));
    }
    for (const m of models) {
        const t = m.releaseDate ? Date.parse(m.releaseDate) : NaN;
        const top = newest.get(m.provider);
        m.legacy = !Number.isNaN(t) && top !== undefined && top - t > 365 * 86_400_000;
    }
}

type Builder = (rt: RuntimeModel) => ModelInfo;

/** Turns runtime models into `ModelInfo` (models.dev match, names, logos, limits, features) for one user. */
function modelBuilder(userId: string, cat: ReturnType<typeof catalog>, providers: Record<string, Provider>): Builder {
    const m = getMatcher();
    const features = modelFeatureResolver(userId);
    // One serving-provider lookup per provider, not per model.
    const serving = new Map<string, string | undefined>();
    const servingFor = (provider: string, baseUrl?: string) => {
        const key = `${provider}\n${baseUrl ?? ""}`;
        if (!serving.has(key)) serving.set(key, m.devProvider(provider, baseUrl));
        return serving.get(key);
    };
    return (rt) => {
        const id = `${rt.provider}/${rt.id}`;
        const cfg = providers[rt.provider];
        const hit = m.match(rt.provider, rt.id, cfg?.baseUrl ?? rt.baseUrl);
        const dev = hit?.model;
        const servingDev = servingFor(rt.provider, cfg?.baseUrl ?? rt.baseUrl);
        const lab = labFor(rt.id, dev);
        const labDev = lab && cat[lab] ? lab : undefined;
        // The provider logo is the serving provider's. An unknown provider keeps its own id (the logo route then
        // 404s and the client draws a lettermark) so a lab logo is never shown as the provider's.
        const logoKey = servingDev ?? rt.provider;
        const efforts = (rt.thinking?.efforts ?? []).filter((e): e is ThinkingEffort =>
            EFFORTS.includes(e as ThinkingEffort),
        );
        const info: Omit<ModelInfo, "features"> = {
            id,
            provider: rt.provider,
            providerName: cfg?.label ?? (servingDev ? cat[servingDev]!.name : rt.provider),
            modelId: rt.id,
            // Prefer the runtime's explicit name when it is not just the id.
            name: rt.name && rt.name !== rt.id ? rt.name : (dev?.name ?? rt.id),
            logo: `/api/models/logos/${logoKey}.svg`,
            labLogo: labDev && labDev !== servingDev ? `/api/models/logos/${labDev}.svg` : undefined,
            labName: labDev ? cat[labDev]!.name : undefined,
            family: dev?.family,
            reasoning: rt.reasoning ?? dev?.reasoning ?? false,
            efforts,
            input: inputs(rt, dev),
            toolCall: dev?.tool_call ?? true,
            contextWindow: rt.contextWindow ?? dev?.limit?.context,
            maxOutput: rt.maxTokens ?? dev?.limit?.output,
            cost: dev?.cost
                ? {
                      input: dev.cost.input,
                      output: dev.cost.output,
                      cacheRead: dev.cost.cache_read,
                      cacheWrite: dev.cost.cache_write,
                  }
                : rt.cost,
            releaseDate: dev?.release_date,
            knowledge: dev?.knowledge,
            openWeights: dev?.open_weights,
            legacy: false,
            matched: hit ? { provider: hit.provider, model: hit.model.id, score: hit.score } : undefined,
        };
        return { ...info, features: features.resolve(info) };
    };
}

/**
 * The built list for each user, reused while its inputs are the same objects or values: the runtime's
 * cached model list, the catalogue, and the provider, policy and default-model settings. Building it
 * matches every model against models.dev. Reuse avoids that work on repeated model-picker requests.
 */
const built = new Map<
    string,
    { runtime: RuntimeModel[]; catalog: object; settings: string; response: ModelsResponse }
>();

export async function listModels(userId: string): Promise<ModelsResponse> {
    // Catalogue refresh must not delay cached runtime models; metadata appears on the next request.
    const cat = catalog();
    const errors: ModelsResponse["errors"] = [];
    let runtime: RuntimeModel[] = [];
    let current = true;
    try {
        const listing = await runtimeListing(userId);
        runtime = listing.info.models;
        current = listing.current;
    } catch (err) {
        errors.push({ provider: "*", message: (err as Error).message });
    }
    const providers = resolveSetting("agent.providers", userId).value as Record<string, Provider>;
    const preferred = setting("agent.defaultModel", userId);
    const switchedOn = modelSwitch(userId);
    const runtimeOk = errors.length === 0;
    const settings = JSON.stringify([
        providers,
        preferred,
        modelFeatureResolver(userId).key,
    ]);
    const cached = built.get(userId);
    if (runtimeOk && current && cached?.runtime === runtime && cached.catalog === cat && cached.settings === settings)
        return cached.response;
    const build = modelBuilder(userId, cat, providers);

    const models: ModelInfo[] = [];
    for (const rt of runtime) {
        const id = `${rt.provider}/${rt.id}`;
        if (!switchedOn(id)) continue;
        const cfg = providers[rt.provider];
        // A stale listing must not retain a removed or disabled configured provider.
        if (cfg?.enabled === false || (!current && !cfg)) continue;
        models.push(build(rt));
    }
    markLegacy(models);

    // A listing made for an older config has not seen newly added providers yet; do not report them as
    // broken while the refresh runs (clients refetch on chat.models.updated).
    const configured = Object.entries(providers).filter(([, p]) => p.enabled);
    for (const [pid] of current ? configured : []) {
        if (!runtime.some((r) => r.provider === pid))
            errors.push({ provider: pid, message: "No models available from this provider" });
    }

    const defaultModel =
        models.find((x) => x.id === preferred)?.id ?? models.find((x) => !x.legacy)?.id ?? models[0]?.id ?? null;
    const response = { models, defaultModel, errors };
    if (runtimeOk && current) built.set(userId, { runtime, catalog: cat, settings, response });
    return response;
}

/**
 * One provider's models for its settings page, including models turned off on the entry, so they can be turned
 * back on. Loaded only by that page.
 */
export async function providerModels(userId: string, providerId: string): Promise<ProviderModelsResponse> {
    const providers = resolveSetting("agent.providers", userId).value as Record<string, Provider>;
    const entry = providers[providerId];
    const disabled = entry?.disabledModels ?? [];
    if (entry && !entry.enabled)
        return { models: [], disabled, blocked: [], current: true, error: "This provider is turned off" };
    let runtime: RuntimeModel[] = [];
    let current = true;
    let error: string | undefined;
    try {
        const listing = await runtimeListing(userId);
        runtime = listing.info.models.filter((rt) => rt.provider === providerId);
        current = listing.current;
    } catch (err) {
        error = (err as Error).message;
    }
    const build = modelBuilder(userId, catalog(), providers);
    const models = runtime.map(build);
    markLegacy(models);
    return {
        models,
        disabled,
        blocked: [],
        checkedAt: cachedInfo(userId)?.at,
        current,
        error: error ?? (current && entry && !models.length ? "No models available from this provider" : undefined),
    };
}

// Catalogue: the chat models, served in pages of one snapshot.

/** A model in the catalogue. `execution` keeps the wire shape the web client reads: every model here chats. */
export interface CatalogueModel extends ModelInfo {
    execution: { chat: true; decisions: null };
}

export interface CatalogueIndex {
    ownerId: string;
    /** Opaque digest of the content. It changes after any provider, model, policy or default edit. */
    revision: string;
    pageSize: number;
    /** Number of pages, numbered from 0. */
    parts: number;
    total: number;
    defaultModel: string | null;
    errors: ModelsResponse["errors"];
}

export interface CataloguePage {
    ownerId: string;
    revision: string;
    part: number;
    models: CatalogueModel[];
}

/** The revision asked for is not the current one: the client reloads from the index. */
export class CatalogueConflict extends Error {}
/** The page number is outside the snapshot. */
export class CatalogueMissing extends Error {}

export const CATALOGUE_PAGE_SIZE = 128;

interface Snapshot {
    index: CatalogueIndex;
    pages: CatalogueModel[][];
}

/** The latest snapshot per user. Older revisions are not kept: a page for one answers with a conflict. */
const snapshots = new Map<string, Snapshot>();

async function buildSnapshot(userId: string): Promise<Snapshot> {
    const chat = await listModels(userId);
    const models: CatalogueModel[] = chat.models.map((m) => ({ ...m, execution: { chat: true, decisions: null } }));
    const errors = chat.errors;
    const defaultModel = chat.defaultModel;
    const revision = `c1-${createHash("sha256").update(JSON.stringify({ models, defaultModel, errors })).digest("hex").slice(0, 24)}`;
    const previous = snapshots.get(userId);
    if (previous?.index.revision === revision) return previous;
    const pages: CatalogueModel[][] = [];
    for (let i = 0; i < models.length; i += CATALOGUE_PAGE_SIZE) pages.push(models.slice(i, i + CATALOGUE_PAGE_SIZE));
    const snapshot: Snapshot = {
        index: {
            ownerId: userId,
            revision,
            pageSize: CATALOGUE_PAGE_SIZE,
            parts: pages.length,
            total: models.length,
            defaultModel,
            errors,
        },
        pages,
    };
    snapshots.set(userId, snapshot);
    return snapshot;
}

/** The small index of the current catalogue: its revision, size and diagnostics, with no model rows. */
export async function catalogueIndex(userId: string): Promise<CatalogueIndex> {
    return (await buildSnapshot(userId)).index;
}

/** One page of the catalogue at `revision`. Rebuilds first, so an edit since the index was read is a conflict. */
export async function cataloguePage(userId: string, revision: string, part: number): Promise<CataloguePage> {
    const { index, pages } = await buildSnapshot(userId);
    if (index.revision !== revision) throw new CatalogueConflict("The catalogue changed");
    const models = pages[part];
    if (!models) throw new CatalogueMissing("No such page");
    return { ownerId: userId, revision, part, models };
}

/** List the user's models again now (settings "Refresh models"), ignoring the cache age and the retry pause. */
export async function refreshModels(userId: string): Promise<void> {
    failed.delete(userId);
    await refresh(userId);
}

export function forgetModels(userId?: string): void {
    if (userId) {
        runtimeCache.delete(userId);
        built.delete(userId);
        snapshots.delete(userId);
    } else {
        runtimeCache.clear();
        built.clear();
        snapshots.clear();
    }
}
