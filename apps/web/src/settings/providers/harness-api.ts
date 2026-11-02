/**
 * The harness endpoints the Providers page uses, through the host's `/app/harness` proxy.
 *
 * The proxy attaches the operator capability server-side; the browser only has to send the
 * workspace header. A key or a sign-in code leaves this module in exactly one request body
 * and is never stored, returned, or put in an error message.
 */

import { Option, Schema } from "effect";
import { HARNESS_API_BASE } from "../../host/paths";

export class HarnessError extends Error {
    readonly status: number;
    /** The server's stable machine-readable reason, when it sent one. */
    readonly code: string | undefined;
    /** Nothing answered as the harness: it is not running, or the host has none. */
    readonly unreachable: boolean;
    /** The refusal's extra fields, such as `code`. */
    readonly extra: Readonly<Record<string, unknown>>;

    constructor(
        message: string,
        status: number,
        options: { code?: string; unreachable?: boolean; extra?: Record<string, unknown> } = {},
    ) {
        super(message);
        this.name = "HarnessError";
        this.status = status;
        this.code = options.code;
        this.unreachable = options.unreachable ?? false;
        this.extra = options.extra ?? {};
    }
}

export interface ProviderHealth {
    kind: string;
    configured_model: string | null;
    ready: boolean;
    credential: string;
    auth_mode: string;
    credential_owner: string;
    readiness_error: string | null;
    interface: string;
}

export type KeySource = "stored" | "environment" | "missing";

export interface KeyEntry {
    alias: string;
    kind: string;
    credential_env: string | null;
    set: boolean;
    updated_at: string | null;
    source: KeySource;
}

export interface CatalogEntry {
    kind: string;
    support_tier: string;
    interface: string;
}

export interface ModelCatalog {
    available: boolean;
    providers: Record<string, { id: string; name: string; models: Array<{ id: string; name?: string }> }>;
    kinds: Record<string, string[]>;
}

export type AttemptState = "starting" | "awaiting_user" | "succeeded" | "failed" | "cancelled" | "expired";

export interface Attempt {
    id: string;
    cli: string;
    state: AttemptState;
    method: "device_code" | "url_code" | "desktop_only";
    verification_url: string | null;
    user_code: string | null;
    expects_code: boolean;
    started_at: string;
    expires_at: string | null;
    message: string | null;
    code_submissions: number;
}

export interface CliStatus {
    cli: string;
    label: string;
    installed: boolean;
    signed_in: boolean | null;
    account: string | null;
    method: string | null;
    browser_sign_in: boolean;
    can_sign_out: boolean;
    manual_hint: string | null;
    error: string | null;
    attempt: Attempt | null;
}

export interface ConnectionBody {
    alias: string;
    kind: string;
    model: string;
    base_url?: string;
    credential_env?: string;
    auth_mode?: string;
}

export interface ConnectionResult {
    provider: string;
    ready: boolean;
    readiness_error: string | null;
}

const Rest = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** Every refusal is `{detail, code?, ...}`; FastAPI's own validation sends `detail` as a list. */
const ErrorBody = Schema.Struct(
    {
        detail: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.Struct({ msg: Schema.String }, Rest)))),
        error: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
    },
    Rest,
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${HARNESS_API_BASE}${path}`, {
            method,
            headers: {
                accept: "application/json",
                "x-pikvm-workspace": "1",
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            credentials: "same-origin",
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            ...(signal ? { signal } : {}),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new HarnessError("Cannot reach the app server.", 0, { unreachable: true });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
        parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
        parsed = undefined;
    }
    if (response.ok) return parsed as T;

    // A harness that is down is answered by the host (a bare 502/503/504, not JSON); a harness
    // that is up answers in JSON, even when it refuses.
    const unreachable = parsed === undefined && response.status >= 500;
    const errorBody = Option.getOrUndefined(decodeErrorBody(parsed));
    const { detail, error, code, ...extra } = errorBody ?? {};
    const message =
        typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((item) => item.msg).join("; ") : error;
    throw new HarnessError(
        unreachable ? "The agent harness is not running." : message || `The harness answered ${response.status}.`,
        response.status,
        { ...(code !== undefined ? { code } : {}), unreachable, extra },
    );
}

const enc = encodeURIComponent;

export const listProviders = (signal?: AbortSignal) =>
    request<Record<string, ProviderHealth>>("GET", "/api/providers", undefined, signal);

export const listProviderKeys = async (signal?: AbortSignal) =>
    (await request<{ keys: KeyEntry[] }>("GET", "/api/provider-keys", undefined, signal)).keys;

export const getProviderCatalog = (signal?: AbortSignal) =>
    request<CatalogEntry[]>("GET", "/api/provider-catalog", undefined, signal);

export const getModelCatalog = (signal?: AbortSignal) =>
    request<ModelCatalog>("GET", "/api/model-catalog", undefined, signal);

/** Set or replace a key. The value is in this request body and nowhere else. */
export const putProviderKey = (alias: string, apiKey: string) =>
    request<KeyEntry>("PUT", `/api/providers/${enc(alias)}/key`, { api_key: apiKey });

export const deleteProviderKey = (alias: string) =>
    request<KeyEntry & { removed: boolean }>("DELETE", `/api/providers/${enc(alias)}/key`);

export const connectWithKey = (connection: ConnectionBody, apiKey: string) =>
    request<{ provider: ConnectionResult; key: KeyEntry }>("POST", "/api/providers/with-key", {
        connection,
        api_key: apiKey,
    });

export const connectProvider = (connection: ConnectionBody) =>
    request<ConnectionResult>("POST", "/api/providers", connection);

export const listCliAuth = async (signal?: AbortSignal) =>
    (await request<{ clis: CliStatus[] }>("GET", "/api/cli-auth", undefined, signal)).clis;

export const startSignIn = (cli: string, replace: boolean) =>
    request<Attempt>("POST", `/api/cli-auth/${enc(cli)}/sign-in`, replace ? { replace: true } : {});

export const getAttempt = (cli: string, signal?: AbortSignal) =>
    request<Attempt>("GET", `/api/cli-auth/${enc(cli)}/sign-in`, undefined, signal);

export const submitSignInCode = (cli: string, authCode: string) =>
    request<Attempt>("POST", `/api/cli-auth/${enc(cli)}/sign-in/code`, { auth_code: authCode });

export const cancelSignIn = (cli: string) => request<Attempt>("DELETE", `/api/cli-auth/${enc(cli)}/sign-in`);

export const signOut = (cli: string) => request<CliStatus>("POST", `/api/cli-auth/${enc(cli)}/sign-out`);

export const isActive = (attempt: Attempt | null | undefined): attempt is Attempt =>
    attempt?.state === "starting" || attempt?.state === "awaiting_user";
