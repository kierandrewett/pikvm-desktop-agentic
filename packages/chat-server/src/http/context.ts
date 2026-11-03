/**
 * Shared Hono context, auth middleware and error mapping.
 */
import { SettingsKeyError } from "@pikvm/chat-protocol";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { OPERATOR, type User } from "../auth/operator.ts";
import { NotFoundError } from "../conversations/service.ts";
import { SettingsWriteError } from "../settings/store.ts";

/** Custom header required on every mutating /api request. Browsers cannot send it cross-site without CORS. */
export const CSRF_HEADER = "x-chat-request";

export type Env = { Variables: { user: User | undefined } };
export type Ctx = Context<Env>;

/** Every request is the operator: the host's own gate decides who may reach the server (auth/operator.ts). */
export const loadUser: MiddlewareHandler<Env> = async (c, next) => {
    c.set("user", OPERATOR);
    await next();
};

/** CSRF guard for our own routes. The auth endpoints run their own origin check. */
export const csrf: MiddlewareHandler<Env> = async (c, next) => {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !c.req.header(CSRF_HEADER)) {
        throw new HTTPException(403, { message: "Missing request header" });
    }
    await next();
};

export function requireUser(c: Ctx): User {
    const u = c.get("user");
    if (!u) throw new HTTPException(401, { message: "Not signed in" });
    return u;
}

export function requireAdmin(c: Ctx): User {
    const u = requireUser(c);
    if (u.role !== "admin") throw new HTTPException(403, { message: "Admin only" });
    return u;
}

export async function body<T>(c: Ctx, schema: { parse(v: unknown): T }): Promise<T> {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        throw new HTTPException(400, { message: "Expected a JSON body" });
    }
    return schema.parse(raw);
}

/** Map known errors to `{ error: { code, message, issues? } }` with a matching status. */
export function onError(err: Error, c: Context): Response {
    const send = (status: number, code: string, message: string, issues?: unknown) =>
        c.json({ error: { code, message, ...(issues ? { issues } : {}) } }, status as 400);
    if (err instanceof HTTPException) return send(err.status, httpCode(err.status), err.message);
    if (err instanceof NotFoundError) return send(404, "not_found", err.message);
    if (err instanceof SettingsKeyError) return send(400, err.code, err.message);
    if (err instanceof SettingsWriteError) {
        return send(err.code === "managed_by_file" ? 409 : 400, err.code, err.message, err.issues);
    }
    if (err instanceof ZodError) return send(400, "invalid_request", "Invalid request", err.issues);
    console.error("[http] unhandled", err);
    return send(500, "internal", "Internal error");
}

function httpCode(status: number): string {
    return ({ 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict" } as Record<
        number,
        string
    >)[status] ?? "error";
}
