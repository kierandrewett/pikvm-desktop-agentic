/**
 * Settings over HTTP.
 *
 * User routes (`/api/settings`) take keys relative to the caller's user space: `PUT /api/settings/agent.mcp`
 * writes `users.operator.agent.mcp`. Admin routes (`/api/admin/settings`) take full keys, for the keys that have no
 * per-user value (the agent runtime and PiKVM switches). The operator is both.
 */
import { allDefs, getDef, parseKey, redact, userKey, USERS_PREFIX, type SettingDef } from "@pikvm/chat-protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { User } from "../auth/operator.ts";
import { deleteValue, getRow, listRows, resolveSetting, setValue } from "../settings/store.ts";
import { body, requireAdmin, requireUser, type Env } from "./context.ts";

const ValueBody = z.object({ value: z.unknown() });

function describe(d: SettingDef, user: User) {
    const r = resolveSetting(d.key, user.id);
    const own = getRow(userKey(user.id, d.key));
    const global = getRow(d.key);
    return {
        key: d.key,
        description: d.description,
        merge: d.merge,
        value: redact(d, r.value),
        source: r.source,
        userValue: own ? redact(d, own.value) : undefined,
                globalValue: global ? redact(d, global.value) : undefined,
        owners: r.owners,
        shadowed: r.shadowed,
        managedByFile: own?.source === "file",
        writable: d.userTwin === "user" && own?.source !== "file",
    };
}

export const settingsRoutes = new Hono<Env>()
    .get("/settings", (c) => {
        const user = requireUser(c);
        const defs = allDefs().filter((d) => d.userTwin !== "none");
        const prefix = `${USERS_PREFIX}.${user.id}.`;
        const free = listRows(prefix)
            .filter((r) => !getDef(r.key.slice(prefix.length)))
            .map((r) => ({ key: r.key.slice(prefix.length), value: r.value }));
        return c.json({ settings: defs.map((d) => describe(d, user)), free });
    })
    .put("/settings/:key", async (c) => {
        const user = requireUser(c);
        const key = c.req.param("key");
        const parsed = parseKey(userKey(user.id, key));
        if (parsed.kind === "user") {
            if (parsed.def.userTwin !== "user") throw new HTTPException(403, { message: `${key} is set by an administrator` });
        }
        const { value } = await body(c, ValueBody);
        const row = setValue(userKey(user.id, key), value, user.id);
        const d = getDef(key);
        return c.json(d ? describe(d, user) : { key, value: row.value });
    })
    .delete("/settings/:key", (c) => {
        const user = requireUser(c);
        const key = c.req.param("key");
        const parsed = parseKey(userKey(user.id, key));
        if (parsed.kind === "user" && parsed.def.userTwin !== "user") {
            throw new HTTPException(403, { message: `${key} is set by an administrator` });
        }
        deleteValue(userKey(user.id, key));
        return c.json({ ok: true });
    });

export const adminSettingsRoutes = new Hono<Env>()
    .get("/settings", (c) => {
        requireAdmin(c);
        const prefix = c.req.query("prefix");
        const rows = listRows(prefix).map((r) => {
            const segs = r.key.split(".");
            const d = getDef(segs[0] === USERS_PREFIX ? segs.slice(2).join(".") : r.key);
            return { ...r, value: d ? redact(d, r.value) : r.value };
        });
        const defs = allDefs().map((d) => ({
            key: d.key,
            description: d.description,
            userTwin: d.userTwin,
            merge: d.merge,
            default: d.default,
            value: redact(d, resolveSetting(d.key).value),
        }));
        return c.json({ rows, defs });
    })
    .put("/settings/:key", async (c) => {
        const admin = requireAdmin(c);
        const { value } = await body(c, ValueBody);
        const row = setValue(c.req.param("key"), value, admin.id);
        const segs = row.key.split(".");
        const d = getDef(segs[0] === USERS_PREFIX ? segs.slice(2).join(".") : row.key);
        return c.json({ ...row, value: d ? redact(d, row.value) : row.value });
    })
    .delete("/settings/:key", (c) => {
        requireAdmin(c);
        return c.json({ ok: deleteValue(c.req.param("key")) });
    });
