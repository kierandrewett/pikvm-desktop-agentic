/**
 * models.dev catalogue: metadata and logos for models. Cached on disk (cache/models.dev.json) and
 * refreshed every `system.modelsDev.refreshHours`. A failed refresh keeps the previous copy.
 * Logos are fetched on demand and cached in cache/logos/<provider>.svg.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { setting } from "../settings/store.ts";

export interface DevModel {
    id: string;
    name: string;
    family?: string;
    attachment?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    knowledge?: string;
    release_date?: string;
    last_updated?: string;
    modalities?: { input?: string[]; output?: string[] };
    open_weights?: boolean;
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
    canonical_model_id?: string;
    status?: string;
}

export interface DevProvider {
    id: string;
    name: string;
    api?: string;
    models: Record<string, DevModel>;
}

export type Catalog = Record<string, DevProvider>;

let memory: { catalog: Catalog; loadedAt: number } | undefined;
let refreshing: Promise<void> | undefined;

function readDisk(): Catalog | undefined {
    try {
        return JSON.parse(readFileSync(paths.modelsDevCache, "utf8")) as Catalog;
    } catch {
        return undefined;
    }
}

async function refresh(): Promise<void> {
    const url = `${setting("system.modelsDev.url").replace(/\/+$/, "")}/api.json`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const catalog = JSON.parse(text) as Catalog;
        mkdirSync(paths.cacheDir, { recursive: true });
        writeFileSync(paths.modelsDevCache, text);
        memory = { catalog, loadedAt: Date.now() };
        onCatalogChange?.();
        console.log(`[models] models.dev refreshed (${Object.keys(catalog).length} providers)`);
    } catch (err) {
        console.warn(`[models] models.dev refresh failed: ${(err as Error).message}`);
    }
}

let onCatalogChange: (() => void) | undefined;
export function setCatalogListener(fn: () => void): void {
    onCatalogChange = fn;
}

/** The catalogue, loading the disk copy synchronously and refreshing in the background when stale. */
export function catalog(): Catalog {
    const maxAge = setting("system.modelsDev.refreshHours") * 3_600_000;
    if (!memory) {
        const disk = readDisk();
        const age = existsSync(paths.modelsDevCache) ? Date.now() - statSync(paths.modelsDevCache).mtimeMs : Infinity;
        memory = { catalog: disk ?? {}, loadedAt: Date.now() - age };
    }
    if (Date.now() - memory.loadedAt > maxAge && !refreshing) {
        refreshing = refresh().finally(() => (refreshing = undefined));
    }
    return memory.catalog;
}

/** Wait for the first catalogue if none is cached yet (first boot). */
export async function ensureCatalog(): Promise<Catalog> {
    const c = catalog();
    if (Object.keys(c).length === 0) await (refreshing ?? refresh());
    return catalog();
}

const LOGO_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const missing = new Set<string>();

/** Logo SVG for a models.dev provider id, cached on disk. Undefined when models.dev has none. */
export async function logo(key: string): Promise<string | undefined> {
    if (!LOGO_KEY.test(key) || missing.has(key)) return undefined;
    const file = join(paths.logosDir, `${key}.svg`);
    if (existsSync(file)) return readFileSync(file, "utf8");
    try {
        const res = await fetch(`${setting("system.modelsDev.url").replace(/\/+$/, "")}/logos/${key}.svg`, {
            signal: AbortSignal.timeout(10_000),
        });
        const text = res.ok ? await res.text() : "";
        if (!text.includes("<svg")) {
            missing.add(key);
            return undefined;
        }
        mkdirSync(paths.logosDir, { recursive: true });
        writeFileSync(file, text);
        return text;
    } catch {
        return undefined;
    }
}
