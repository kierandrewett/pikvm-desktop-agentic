/**
 * OAuth 2.1 for remote MCP servers, run by the Chat server (the runtime's own OAuth only works in a terminal).
 *
 * Follows the MCP authorization spec (2025-11-25 and 2026-07-28):
 * - Protected Resource Metadata (RFC 9728): the 401 challenge's `resource_metadata`, else the path-inserted and root
 *   well-known URLs. `authorization_servers` names the issuer.
 * - Authorisation Server Metadata (RFC 8414) and OIDC discovery in the spec's order. The document's `issuer` must equal
 *   the issuer used to build the URL, and `code_challenge_methods_supported` must list S256.
 * - Client: pre-registered (`oauth.clientId` on the server entry), else a client ID metadata document when the
 *   server supports it and `system.publicUrl` is https, else dynamic registration (RFC 7591), stored per issuer.
 * - Authorisation code with PKCE S256, `state` (single use, 10 minutes, bound to the user), `resource` (RFC 8707) on
 *   authorise, token and refresh requests, RFC 9207 `iss` checked when present or advertised.
 * - Scopes: the challenge's `scope`, else the resource's `scopes_supported`, else none; plus the entry's own scopes and
 *   any step-up scopes.
 * - Revocation (RFC 7009) when the server lists `revocation_endpoint`.
 *
 * Every fetch goes through net.ts (SSRF guard). Nothing here logs a token or a code.
 */
import type { McpServer } from "@pikvm/chat-protocol";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db, schema } from "../db/index.ts";
import { INSTANCE_NAME, publicUrl } from "../env.ts";
import { open, seal } from "./crypto.ts";
import { guardedFetch, type GuardOptions } from "./net.ts";

export interface ResourceMetadata {
    resource?: string;
    authorization_servers?: string[];
    scopes_supported?: string[];
    resource_name?: string;
}

export interface AuthServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    revocation_endpoint?: string;
    code_challenge_methods_supported?: string[];
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    client_id_metadata_document_supported?: boolean;
    authorization_response_iss_parameter_supported?: boolean;
}

export class OAuthError extends Error {
    constructor(
        message: string,
        readonly code: string = "oauth_failed",
    ) {
        super(message);
    }
}

const FETCH_TIMEOUT_MS = 15_000;
const PENDING_TTL_MS = 10 * 60_000;
const META_TTL_MS = 60 * 60_000;

/** `WWW-Authenticate: Bearer a="b", c=d` parameters, lower-case names. */
export function parseChallenge(header: string | null | undefined): Record<string, string> | undefined {
    if (!header || !/^\s*bearer\b/i.test(header)) return undefined;
    const out: Record<string, string> = {};
    for (const m of header
        .replace(/^\s*bearer\s*/i, "")
        .matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g))
        out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    return out;
}

/** The canonical resource URI of a server URL: no fragment, no query, no trailing slash. */
export function canonicalResource(url: string): string {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

/**
 * True when `url` is the resource or sits under it at a path boundary: `https://a/mcp` covers `https://a/mcp` and
 * `https://a/mcp/x`, never `https://a/mcp-other`. Used before any token is sent or any metadata is trusted.
 */
export function withinResource(url: string, resource: string): boolean {
    const u = canonicalResource(url);
    const r = canonicalResource(resource);
    return u === r || u.startsWith(`${r}/`);
}

async function getJson<T>(url: string, guard: GuardOptions): Promise<T | undefined> {
    const res = await guardedFetch(
        url,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        guard,
    );
    if (!res.ok) {
        await res.body?.cancel();
        return undefined;
    }
    try {
        return (await res.json()) as T;
    } catch {
        return undefined;
    }
}

/** Well-known URL with the path inserted after the well-known segment (RFC 8414 / RFC 9728 style). */
function wellKnown(base: string, name: string, withPath: boolean): string {
    const u = new URL(base);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.origin}/.well-known/${name}${withPath && path ? path : ""}`;
}

/** RFC 9728 metadata for a server, from the challenge or the well-known locations. */
export async function discoverResource(
    serverUrl: string,
    challenge: Record<string, string> | undefined,
    guard: GuardOptions,
): Promise<ResourceMetadata | undefined> {
    const candidates = [
        challenge?.resource_metadata,
        wellKnown(serverUrl, "oauth-protected-resource", true),
        wellKnown(serverUrl, "oauth-protected-resource", false),
    ].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
    for (const url of candidates) {
        const meta = await getJson<ResourceMetadata>(url, guard).catch(() => undefined);
        if (meta?.authorization_servers?.length) return meta;
    }
    return undefined;
}

const metaCache = new Map<string, { at: number; meta: AuthServerMetadata }>();

/** RFC 8414 / OIDC metadata for an issuer, in the spec's order, with the exact issuer check. */
export async function discoverAuthServer(issuer: string, guard: GuardOptions): Promise<AuthServerMetadata> {
    const hit = metaCache.get(issuer);
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/+$/, "");
    const urls = path
        ? [
              `${u.origin}/.well-known/oauth-authorization-server${path}`,
              `${u.origin}/.well-known/openid-configuration${path}`,
              `${u.origin}${path}/.well-known/openid-configuration`,
          ]
        : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
    for (const url of urls) {
        const meta = await getJson<AuthServerMetadata>(url, guard).catch(() => undefined);
        if (!meta) continue;
        if (meta.issuer !== issuer)
            throw new OAuthError(
                `The authorisation server says it is ${meta.issuer}, not ${issuer}`,
                "issuer_mismatch",
            );
        if (!meta.authorization_endpoint || !meta.token_endpoint)
            throw new OAuthError("The authorisation server metadata has no authorisation or token endpoint");
        if (!meta.code_challenge_methods_supported?.includes("S256"))
            throw new OAuthError(
                "The authorisation server does not support PKCE with S256, so Chat cannot sign in safely",
                "no_pkce",
            );
        metaCache.set(issuer, { at: Date.now(), meta });
        return meta;
    }
    throw new OAuthError(`Could not find authorisation server metadata for ${issuer}`, "no_metadata");
}

export interface OAuthClient {
    clientId: string;
    clientSecret?: string;
    method: "static" | "metadata" | "dynamic";
}

/** Where a client ID metadata document is served (needs an https public URL). */
export function metadataClientId(): string | undefined {
    const pub = publicUrl().replace(/\/+$/, "");
    return pub.startsWith("https://") ? `${pub}/api/mcp/oauth/client.json` : undefined;
}

export function clientMetadataDocument(redirectUri: string): Record<string, unknown> | undefined {
    const id = metadataClientId();
    if (!id) return undefined;
    return {
        client_id: id,
        client_name: INSTANCE_NAME,
        client_uri: publicUrl(),
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
    };
}

/** Pre-registered, metadata document, stored registration, or a new dynamic registration (spec priority). */
async function clientFor(
    meta: AuthServerMetadata,
    redirectUri: string,
    entry: McpServer,
    guard: GuardOptions,
): Promise<OAuthClient> {
    if (entry.oauth?.clientId)
        return {
            clientId: entry.oauth.clientId,
            clientSecret: entry.oauth.clientSecret || undefined,
            method: "static",
        };
    const docId = metadataClientId();
    if (meta.client_id_metadata_document_supported && docId && redirectUri.startsWith(publicUrl()))
        return { clientId: docId, method: "metadata" };
    const where = and(
        eq(schema.mcpOauthClients.issuer, meta.issuer),
        eq(schema.mcpOauthClients.redirectUri, redirectUri),
    );
    const stored = db.select().from(schema.mcpOauthClients).where(where).get();
    if (stored) {
        return {
            clientId: stored.clientId,
            clientSecret: open(stored.clientSecret, `mcp-client|${meta.issuer}|${redirectUri}`),
            method: "dynamic",
        };
    }
    if (!meta.registration_endpoint)
        throw new OAuthError(
            "This server does not accept new clients automatically. An administrator can add a client ID for it.",
            "no_registration",
        );
    const res = await guardedFetch(
        meta.registration_endpoint,
        {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
                client_name: INSTANCE_NAME,
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
                application_type: "web",
            }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
        guard,
    );
    const body = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    if (!res.ok || !body.client_id)
        throw new OAuthError(`Client registration failed (HTTP ${res.status})`, "registration_failed");
    db.insert(schema.mcpOauthClients)
        .values({
            issuer: meta.issuer,
            redirectUri,
            clientId: body.client_id,
            clientSecret: body.client_secret
                ? seal(body.client_secret, `mcp-client|${meta.issuer}|${redirectUri}`)
                : null,
            method: "dynamic",
        })
        .onConflictDoNothing()
        .run();
    return { clientId: body.client_id, clientSecret: body.client_secret, method: "dynamic" };
}

/** Client authentication for the token and revocation endpoints. */
function clientAuth(
    meta: AuthServerMetadata,
    client: OAuthClient,
    form: URLSearchParams,
    headers: Record<string, string>,
) {
    form.set("client_id", client.clientId);
    if (!client.clientSecret) return;
    const methods = meta.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (methods.includes("client_secret_basic")) {
        const enc = (v: string) => encodeURIComponent(v);
        headers.authorization = `Basic ${btoa(`${enc(client.clientId)}:${enc(client.clientSecret)}`)}`;
    } else form.set("client_secret", client.clientSecret);
}

export interface TokenSet {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scope: string;
    account?: string;
}

/** Display name from an OpenID id_token, without trusting it for anything else. */
function accountFromIdToken(idToken: unknown): string | undefined {
    if (typeof idToken !== "string") return undefined;
    try {
        const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
            string,
            unknown
        >;
        const v = claims.email ?? claims.preferred_username ?? claims.name ?? claims.sub;
        return typeof v === "string" ? v.slice(0, 200) : undefined;
    } catch {
        return undefined;
    }
}

async function tokenRequest(
    meta: AuthServerMetadata,
    client: OAuthClient,
    params: Record<string, string>,
    guard: GuardOptions,
    previous?: { refreshToken?: string; scope: string },
): Promise<TokenSet> {
    const form = new URLSearchParams(params);
    const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
    };
    clientAuth(meta, client, form, headers);
    const res = await guardedFetch(
        meta.token_endpoint,
        { method: "POST", headers, body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        guard,
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
        const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new OAuthError(
            `The token request was refused (${reason})`,
            reason === "invalid_grant" ? "invalid_grant" : "token_failed",
        );
    }
    if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer")
        throw new OAuthError(`Unsupported token type ${body.token_type}`);
    const expiresIn = Number(body.expires_in);
    return {
        accessToken: body.access_token,
        // A refresh answer without a new refresh token keeps the old one (no rotation).
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
        scope: typeof body.scope === "string" ? body.scope : (previous?.scope ?? params.scope ?? ""),
        account: accountFromIdToken(body.id_token),
    };
}

interface Pending {
    userId: string;
    serverId: string;
    resource: string;
    issuer: string;
    redirectUri: string;
    verifier: string;
    client: OAuthClient;
    scope: string;
    createdAt: number;
}

const pending = new Map<string, Pending>();

function sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, p] of pending) if (p.createdAt < cutoff) pending.delete(k);
}

function union(...lists: (string | undefined)[]): string {
    return [...new Set(lists.flatMap((l) => (l ?? "").split(/\s+/)).filter(Boolean))].join(" ");
}

export interface AuthTarget {
    userId: string;
    serverId: string;
    entry: McpServer;
    guard: GuardOptions;
}

/** What a 401 from the server says about signing in. */
export interface AuthNeeds {
    resource: string;
    resourceMeta?: ResourceMetadata;
    issuer: string;
    meta: AuthServerMetadata;
    challengeScope?: string;
}

/** Resource and authorisation server for a server URL, from its challenge or well-known metadata. */
export async function authNeeds(
    serverUrl: string,
    challenge: Record<string, string> | undefined,
    guard: GuardOptions,
): Promise<AuthNeeds> {
    const rm = await discoverResource(serverUrl, challenge, guard);
    if (!rm)
        throw new OAuthError(
            "The server asks for a sign-in but publishes no protected resource metadata",
            "no_resource_metadata",
        );
    const resource = rm.resource ? rm.resource : canonicalResource(serverUrl);
    // The metadata must describe this server: same origin, and the server URL sits under the resource.
    const ru = new URL(resource);
    const su = new URL(serverUrl);
    if (ru.origin !== su.origin || !withinResource(serverUrl, resource))
        throw new OAuthError(
            `The protected resource metadata is for ${resource}, not this server`,
            "resource_mismatch",
        );
    const issuer = rm.authorization_servers![0]!;
    const meta = await discoverAuthServer(issuer, guard);
    return { resource: canonicalResource(resource), resourceMeta: rm, issuer, meta, challengeScope: challenge?.scope };
}

/** Begin a sign-in: returns the authorisation URL for the browser. */
export async function beginAuthorization(
    target: AuthTarget,
    needs: AuthNeeds,
    redirectUri: string,
    extraScope?: string,
): Promise<string> {
    sweepPending();
    const client = await clientFor(needs.meta, redirectUri, target.entry, target.guard);
    const scope = union(
        needs.challengeScope ?? needs.resourceMeta?.scopes_supported?.join(" "),
        target.entry.oauth?.scopes?.join(" "),
        extraScope,
    );
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    pending.set(state, {
        userId: target.userId,
        serverId: target.serverId,
        resource: needs.resource,
        issuer: needs.issuer,
        redirectUri,
        verifier,
        client,
        scope,
        createdAt: Date.now(),
    });
    const url = new URL(needs.meta.authorization_endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new OAuthError("The authorisation address is not http or https");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("resource", needs.resource);
    if (scope) url.searchParams.set("scope", scope);
    return url.toString();
}

export interface Completed {
    userId: string;
    serverId: string;
    resource: string;
    issuer: string;
    clientId: string;
    tokens: TokenSet;
}

/**
 * Finish a sign-in from the callback query. `userId` is the signed-in user of the callback request: a state made for
 * someone else is refused. The state is removed on first use, success or not.
 */
export async function completeAuthorization(
    userId: string,
    query: { state?: string; code?: string; iss?: string; error?: string; error_description?: string },
    guardFor: (serverId: string) => GuardOptions,
): Promise<Completed> {
    const p = query.state ? pending.get(query.state) : undefined;
    if (!p || Date.now() - p.createdAt > PENDING_TTL_MS)
        throw new OAuthError(
            "This sign-in link is not valid or has expired. Start again from Settings.",
            "invalid_state",
        );
    pending.delete(query.state!);
    if (p.userId !== userId) throw new OAuthError("This sign-in was started by another account.", "invalid_state");
    const guard = guardFor(p.serverId);
    const meta = await discoverAuthServer(p.issuer, guard);
    // RFC 9207: an `iss` that is present must match exactly; one the server promises must be present.
    if (query.iss !== undefined ? query.iss !== p.issuer : meta.authorization_response_iss_parameter_supported)
        throw new OAuthError("The sign-in answer came from a different authorisation server.", "issuer_mismatch");
    if (query.error)
        throw new OAuthError(
            query.error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed (${query.error})`,
            query.error,
        );
    if (!query.code) throw new OAuthError("The sign-in answer has no code.");
    const tokens = await tokenRequest(
        meta,
        p.client,
        {
            grant_type: "authorization_code",
            code: query.code,
            redirect_uri: p.redirectUri,
            code_verifier: p.verifier,
            resource: p.resource,
        },
        guard,
        { scope: p.scope },
    );
    return {
        userId,
        serverId: p.serverId,
        resource: p.resource,
        issuer: p.issuer,
        clientId: p.client.clientId,
        tokens,
    };
}

/** Client details again for refresh and revocation (registration rows, or the entry's static client). */
export async function clientAgain(
    issuer: string,
    clientId: string,
    entry: McpServer | undefined,
): Promise<OAuthClient> {
    if (entry?.oauth?.clientId === clientId)
        return { clientId, clientSecret: entry.oauth.clientSecret || undefined, method: "static" };
    const row = db
        .select()
        .from(schema.mcpOauthClients)
        .where(and(eq(schema.mcpOauthClients.issuer, issuer), eq(schema.mcpOauthClients.clientId, clientId)))
        .get();
    if (row)
        return {
            clientId,
            clientSecret: open(row.clientSecret, `mcp-client|${issuer}|${row.redirectUri}`),
            method: row.method,
        };
    return { clientId, method: "metadata" };
}

export async function refreshTokens(
    issuer: string,
    client: OAuthClient,
    refreshToken: string,
    resource: string,
    scope: string,
    guard: GuardOptions,
): Promise<TokenSet> {
    const meta = await discoverAuthServer(issuer, guard);
    return tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: refreshToken, resource }, guard, {
        refreshToken,
        scope,
    });
}

/** RFC 7009. Best effort: false when the server has no revocation endpoint or refused. */
export async function revokeToken(
    issuer: string,
    client: OAuthClient,
    token: string,
    hint: string,
    guard: GuardOptions,
): Promise<boolean> {
    try {
        const meta = await discoverAuthServer(issuer, guard);
        if (!meta.revocation_endpoint) return false;
        const form = new URLSearchParams({ token, token_type_hint: hint });
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
        clientAuth(meta, client, form, headers);
        const res = await guardedFetch(
            meta.revocation_endpoint,
            { method: "POST", headers, body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
            guard,
        );
        await res.body?.cancel();
        return res.ok;
    } catch {
        return false;
    }
}
