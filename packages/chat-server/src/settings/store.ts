/**
 * Settings KV store over the `settings` table (the only key/value table in the schema). Values are JSON. Registered keys are validated
 * against the protocol registry on every write. Secret leaves are sealed at rest.
 */
import {
    getDef,
    mapSecrets,
    parseKey,
    renamedKey,
    RESERVED_MCP_SERVER_IDS,
    USERS_PREFIX,
    resolve,
    unmask,
    userKey,
    validateValue,
    type ParsedKey,
    type Resolved,
    type SettingDef,
    type settingDefs,
} from "@pikvm/chat-protocol";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, now, schema } from "../db/index.ts";
import { open, seal } from "../mcp/crypto.ts";

type Defs = (typeof settingDefs)[number];
export type SettingKey = Defs["key"];
export type SettingValue<K extends SettingKey> = z.output<Extract<Defs, { key: K }>["schema"]>;

export interface Row {
    key: string;
    value: unknown;
    source: "db" | "file";
    updatedAt: number;
    updatedBy: string | null;
}

export class SettingsWriteError extends Error {
    constructor(
        message: string,
        readonly code: "managed_by_file" | "invalid_value",
        readonly issues?: unknown,
    ) {
        super(message);
    }
}

type Listener = (key: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to changes. Called with the full key after every committed write or delete. */
export function onSettingsChange(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function emitChange(key: string): void {
    for (const fn of listeners) {
        try {
            fn(key);
        } catch (err) {
            console.error("[settings] listener failed", err);
        }
    }
}

const { settings } = schema;

/** The registered key behind a stored key (`users.<id>.agent.providers` is `agent.providers`), or undefined. */
function defOf(fullKey: string): SettingDef | undefined {
    const segs = fullKey.split(".");
    return getDef(segs[0] === USERS_PREFIX ? segs.slice(2).join(".") : fullKey);
}

/**
 * Secret leaves (provider keys, MCP headers) are sealed at rest with AES-256-GCM keyed from `secret.key` (mcp/crypto.ts),
 * bound to their key and path so a ciphertext moved to another row does not open. A value that is not sealed (a row
 * written before sealing) reads as it is and is sealed by its next write.
 */
function sealed(fullKey: string, d: SettingDef | undefined, value: unknown): unknown {
    if (!d) return value;
    return mapSecrets(d, value, (leaf, path) => seal(leaf, `setting:${fullKey}:${path.join(".")}`));
}

function unsealed(fullKey: string, d: SettingDef | undefined, value: unknown): unknown {
    if (!d) return value;
    return mapSecrets(d, value, (leaf, path) => open(leaf, `setting:${fullKey}:${path.join(".")}`) ?? (leaf.startsWith("v1.") ? "" : leaf));
}

function unsealRow(r: Row): Row {
    return { ...r, value: unsealed(r.key, defOf(r.key), r.value) };
}

export function getRow(fullKey: string): Row | undefined {
    const r = db.select().from(settings).where(eq(settings.key, fullKey)).get() as Row | undefined;
    return r && unsealRow(r);
}

export function listRows(prefix?: string): Row[] {
    const q = db.select().from(settings);
    // Range scan instead of LIKE so key characters need no escaping.
    const rows = (
        prefix
            ? q
                  .where(and(gte(settings.key, prefix), lt(settings.key, `${prefix}\uffff`)))
                  .orderBy(settings.key)
                  .all()
            : q.orderBy(settings.key).all()
    ) as Row[];
    return rows.map(unsealRow);
}

function upsert(key: string, value: unknown, source: "db" | "file", by: string): void {
    const row = { key, value: sealed(key, defOf(key), value), source, updatedAt: now(), updatedBy: by };
    db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run();
}

/** `conversations` and `pikvm` name the built-in MCP endpoints: a configured server may not take them. */
function rejectReservedServers(servers: unknown): void {
    const taken = Object.keys((servers ?? {}) as Record<string, unknown>).filter((id) =>
        RESERVED_MCP_SERVER_IDS.has(id),
    );
    if (!taken.length) return;
    const names = taken.map((id) => `"${id}"`).join(", ");
    throw new SettingsWriteError(
        `MCP server id ${names} is reserved for Chat's built-in servers. Choose another id.`,
        "invalid_value",
    );
}

/** Validate a value for a parsed key. Free-form user keys accept any JSON. */
function validate(parsed: ParsedKey, value: unknown, stored: unknown): unknown {
    if (parsed.kind === "userFree") return value;
    const withSecrets = unmask(parsed.def, value, stored);
    try {
        const clean = validateValue(parsed.def, withSecrets);
        if (parsed.def.key === "agent.mcp") rejectReservedServers(clean);
        return clean;
    } catch (err) {
        if (err instanceof SettingsWriteError) throw err;
        const issues = (err as { issues?: unknown }).issues;
        throw new SettingsWriteError(`Invalid value for ${parsed.key}`, "invalid_value", issues);
    }
}

export function setValue(fullKey: string, value: unknown, actor: string): Row {
    const parsed = parseKey(fullKey);
    const existing = getRow(fullKey);
    if (existing?.source === "file") {
        throw new SettingsWriteError(`${fullKey} is managed by config.toml`, "managed_by_file");
    }
    const clean = validate(parsed, value, existing?.value);
    upsert(fullKey, clean, "db", actor);
    emitChange(fullKey);
    return getRow(fullKey)!;
}

export function deleteValue(fullKey: string): boolean {
    // A renamed key cannot be written, but a row an older build kept can still be removed.
    const segs = fullKey.split(".");
    if (!renamedKey(segs[0] === USERS_PREFIX ? segs.slice(2).join(".") : fullKey)) parseKey(fullKey);
    const existing = getRow(fullKey);
    if (!existing) return false;
    if (existing.source === "file") {
        throw new SettingsWriteError(`${fullKey} is managed by config.toml`, "managed_by_file");
    }
    deleteRow(fullKey);
    emitChange(fullKey);
    return true;
}

export function deleteRow(fullKey: string): void {
    db.delete(settings).where(eq(settings.key, fullKey)).run();
}

/** Effective value of a registered key, for a user (merging their twin) or globally. */
export function resolveSetting(key: string, userId?: string): Resolved {
    const d = getDef(key);
    if (!d) throw new Error(`[settings] unknown key ${key}`);
    const globalValue = getRow(key)?.value;
    const userValue = userId && d.userTwin !== "none" ? getRow(userKey(userId, key))?.value : undefined;
    return resolve(d, globalValue, userValue);
}

/** Typed effective value. */
export function setting<K extends SettingKey>(key: K, userId?: string): SettingValue<K> {
    return resolveSetting(key, userId).value as SettingValue<K>;
}

export type { SettingDef };
