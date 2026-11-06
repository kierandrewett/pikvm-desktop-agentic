/**
 * The web host's own sign-in. The desktop has its single token gate (../auth.ts); the headless host has this, with up to
 * three ways in, any combination, each switched on by its environment variables (see ./config.ts):
 *
 *   access token   `Authorization: Bearer <PIKVM_ACCESS_TOKEN>` for a remote desktop app or a script; the same token
 *                  typed into the sign-in form
 *   password       PIKVM_LOGIN_USER + a scrypt hash (or the plain password): the sign-in form, and `Authorization: Basic`
 *   OIDC           this host is the relying party of an OpenID Connect provider (./oidc.ts)
 *
 * The form methods and OIDC end in a signed session cookie (./session.ts). The two header credentials are NOT
 * sessions and never become one:
 *
 *   - a request carrying `Authorization: Bearer` is judged by the bearer rules only: valid, or refused. It never falls
 *     back to a cookie or to Basic, and a bearer is never turned into a cookie;
 *   - `Authorization: Basic` is judged by the password rules only;
 *   - a session cookie is never accepted as a bearer or as Basic (those headers are read from the header, nothing else).
 *
 * There is no loopback exemption: once a method is configured, a peer on this machine signs in like anyone else. Where
 * a secret may travel is judged by `transportOk`: https as far as this host can tell (PIKVM_PUBLIC_URL is https, or with
 * PIKVM_TRUST_PROXY=1 the proxy's X-Forwarded-Proto says so), or a peer on this machine. The password, the token typed
 * into the form and Basic are refused anywhere else, with no override. Failed attempts from one client address
 * are slowed down exponentially, and all of them together are capped (./limiter.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { bearerVerdict, isPublicPath, isLoopback, loginPage, parseCookies, sameOrigin, tokenMatches, type LoginOptions } from "../auth";
import { json, readBody } from "../http";
import { AuthCodes, CHALLENGE, DEVICE_TOKEN_PREFIX, DeviceStore, STATE, cleanDeviceName, consentPage, devicePageError } from "./devices";
import { AttemptLimiter, type LimiterOptions } from "./limiter";
import { OidcClient, OidcError, type OidcConfig } from "./oidc";
import { createPasswordLogin, parseBasic, type PasswordConfig, type PasswordLogin, type Scrypt } from "./password";
import { cookieHeader, FLOW_COOKIE, FLOW_COOKIE_PATH, SESSION_COOKIE, Sessions, FLOW_TTL_MS, SESSION_TTL_MS, type Method } from "./session";

/** What the sign-in page says for every refused credential: the same words whichever part was wrong. */
export const REFUSED = "That did not work.";
export const OVER_HTTPS = "Sign in over https.";
const NOT_ALLOWED = "That account is not allowed here.";
const OIDC_FAILED = "Sign-in failed. Try again.";
const OIDC_EXPIRED = "That sign-in expired. Start again.";
const DEFAULT_NEXT = "/app/";
/** The MCP endpoint these sign-in documents describe (routes.ts serves it). */
export const MCP_PATH = "/app/mcp";
const MAX_FORM = 8192;

/** Who a request is, once let in: how it got in and who it is. Never a secret. Only a cookie session (token, password,
 *  oidc) can be signed out of; a bearer, a Basic header or a device token has no session. `deviceId` is set for a device. */
export interface SignedIn {
    method: Method | "bearer" | "basic" | "device";
    subject: string;
    deviceId?: string;
}

export type Verdict =
    | { kind: "allow"; setCookie?: string; signedIn?: SignedIn }
    /** Not signed in, and the client asked for a page. */
    | { kind: "login" }
    | { kind: "deny"; status: 401 | 403 | 429; error: string; retryAfterSec?: number };

export interface WebAuthOptions {
    /** PIKVM_ACCESS_TOKEN; empty = no token method and no bearer. */
    token: string;
    /** PIKVM_SYNC_ALLOW_HTTP=1 */
    allowHttpBearer: boolean;
    password?: PasswordConfig;
    oidc?: OidcConfig;
    /** The origin users see (PIKVM_PUBLIC_URL), no trailing slash. */
    publicOrigin?: string;
    /** Where the signed-in desktop apps are kept (<data dir>/devices.json). Without it they are kept in memory only. */
    devicesPath?: string;
    /** PIKVM_TRUST_PROXY=1: believe X-Forwarded-Proto and X-Forwarded-For (their last hop). */
    trustProxy: boolean;
    sessionKey: Buffer;
    /** Test seams. */
    now?: () => number;
    fetch?: typeof fetch;
    jwksCooldownMs?: number;
    scrypt?: Scrypt;
    limiter?: Partial<LimiterOptions>;
    log?: (line: string) => void;
}

export interface WebAuth {
    /** Which methods are on, for the startup line. */
    methods: string[];
    judge(req: IncomingMessage, path: string): Promise<Verdict>;
    /** Where an unsigned-in page request goes. */
    loginRedirect(url: URL): string;
    /** The sign-in routes: the page, the form post, the OpenID start and callback, sign-out. */
    handles(method: string, path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, url: URL, signedIn?: SignedIn): Promise<void>;
    /** Where an MCP client finds how to sign in (RFC 9728), for the `WWW-Authenticate` header of a refused request to the MCP endpoint. */
    resourceMetadata(req: IncomingMessage): string;
}

/** A return path that stays on this site: one `/`, then not another `/` or a `\` (browsers read both as a host),
 *  no control characters. Anything else is the app's front page. */
export function safeNext(raw: string | null | undefined): string {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return DEFAULT_NEXT;
    if (raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return DEFAULT_NEXT;
    // eslint-disable-next-line no-control-regex
    if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT;
    return raw;
}

/** The last entry of a comma-separated header: the hop the trusted proxy itself appended. */
function lastHop(header: string | string[] | undefined): string | undefined {
    const parts = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",");
    return parts.at(-1)?.trim() || undefined;
}

function page(res: ServerResponse, status: number, html: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        ...headers,
    });
    res.end(html);
}

function see(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(303, { location, "cache-control": "no-store", ...headers });
    res.end();
}

export function createWebAuth(o: WebAuthOptions): WebAuth {
    const now = o.now ?? Date.now;
    const log = o.log ?? ((line: string) => console.log(line));
    const sessions = new Sessions(o.sessionKey, now);
    const limiter = new AttemptLimiter({ now, ...o.limiter });
    const password: PasswordLogin | undefined = o.password ? createPasswordLogin(o.password, o.scrypt) : undefined;
    const oidc = o.oidc ? new OidcClient(o.oidc, { now, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.jwksCooldownMs !== undefined ? { jwksCooldownMs: o.jwksCooldownMs } : {}) }) : undefined;
    const publicHttps = o.publicOrigin?.startsWith("https:") === true;

    const materials: Partial<Record<Method, string>> = {};
    if (o.token) materials.token = o.token;
    if (password) materials.password = password.material;
    if (o.oidc) {
        materials.oidc = [o.oidc.issuer, o.oidc.clientId, o.oidc.allowedGroups.join(","), o.oidc.allowedEmails.join(","), o.oidc.allowedSubjects.join(",")].join("\0");
    }

    /** What a device made under `method` must still match: that method's configuration now, or nothing when it is off. */
    const bindingOf = (method: Method): string | undefined => (materials[method] === undefined ? undefined : sessions.binding(method, materials[method]));
    const devices = new DeviceStore(o.devicesPath, now);
    const codes = new AuthCodes(now);

    const methods = [o.token ? "access token" : "", password ? "password" : "", oidc ? `OIDC (${oidc.host})` : ""].filter(Boolean);

    /** The proxy's X-Forwarded-Proto, when it is believed and present. */
    const forwardedProto = (req: IncomingMessage): string | undefined =>
        o.trustProxy ? lastHop(req.headers["x-forwarded-proto"])?.toLowerCase() : undefined;

    /** May a password, a typed token or a Basic header cross this connection? */
    const transportOk = (req: IncomingMessage): boolean => {
        const proto = forwardedProto(req);
        if (proto !== undefined) return proto === "https";
        return publicHttps || isLoopback(req);
    };

    /** Is the browser's side https, so its cookies carry `Secure`? */
    const secure = (req: IncomingMessage): boolean => {
        const proto = forwardedProto(req);
        return proto !== undefined ? proto === "https" : publicHttps;
    };

    const clientAddress = (req: IncomingMessage): string => {
        const forwarded = o.trustProxy ? lastHop(req.headers["x-forwarded-for"]) : undefined;
        return forwarded && isIP(forwarded) ? forwarded : (req.socket.remoteAddress ?? "unknown");
    };

    const tooMany = (waitMs: number): Verdict => ({
        kind: "deny",
        status: 429,
        error: "Too many attempts. Try again later.",
        retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
    });
    const unauthorized: Verdict = { kind: "deny", status: 401, error: "Unauthorized" };
    const overHttps: Verdict = { kind: "deny", status: 403, error: OVER_HTTPS };

    const sessionCookie = (req: IncomingMessage, method: Method, subject: string): string =>
        cookieHeader(SESSION_COOKIE, sessions.issue(method, subject, materials[method]!), {
            secure: secure(req),
            maxAgeSec: SESSION_TTL_MS / 1000,
        });

    const refuse = (what: string, req: IncomingMessage): void => {
        limiter.fail(clientAddress(req));
        log(`[web] sign-in refused (${what}) from ${clientAddress(req)}`);
    };

    async function bearer(req: IncomingMessage, path: string): Promise<Verdict> {
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return tooMany(wait);
        const presented = String(req.headers.authorization ?? "").slice("Bearer ".length);
        if (presented.startsWith(DEVICE_TOKEN_PREFIX)) return deviceBearer(req, presented, path);
        const verdict = bearerVerdict(req, { token: o.token, allowHttp: o.allowHttpBearer, secureTransport: transportOk });
        if (verdict === "allow") {
            limiter.succeed(clientAddress(req));
            return { kind: "allow", signedIn: { method: "bearer", subject: "access token" } };
        }
        // Only a wrong token counts as a failed guess; a refusal for the Origin or the transport says nothing about it.
        if (o.token && !tokenMatches(presented, o.token)) refuse("bearer", req);
        return unauthorized;
    }

    /** A device token: a bearer under the access token's rules (a connection a secret may cross, no foreign Origin), that can be revoked. */
    function deviceBearer(req: IncomingMessage, presented: string, path: string): Verdict {
        if (!(transportOk(req) || o.allowHttpBearer)) return unauthorized;
        if (req.headers.origin !== undefined && !sameOrigin(req)) return unauthorized;
        const found = devices.verify(presented, bindingOf);
        if (!found) {
            refuse("device token", req);
            return unauthorized;
        }
        // A token an MCP client got is for the MCP endpoint and nothing else: the app's own API and chat are other resources.
        if (found.audience === "mcp" && path !== MCP_PATH) return unauthorized;
        limiter.succeed(clientAddress(req));
        return { kind: "allow", signedIn: { method: "device", subject: found.name, deviceId: found.id } };
    }

    async function basic(req: IncomingMessage): Promise<Verdict> {
        if (!password) return unauthorized;
        if (!transportOk(req)) return overHttps;
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return tooMany(wait);
        const given = parseBasic(String(req.headers.authorization ?? ""));
        if (given && (await password.check(given[0], given[1]))) {
            limiter.succeed(clientAddress(req));
            return { kind: "allow", signedIn: { method: "basic", subject: given[0] } };
        }
        refuse("basic", req);
        return unauthorized;
    }

    function cookie(req: IncomingMessage): Verdict {
        const found = sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], materials);
        if (found) {
            const signedIn: SignedIn = { method: found.session.m, subject: found.session.s };
            if (!found.renewed) return { kind: "allow", signedIn };
            return { kind: "allow", signedIn, setCookie: cookieHeader(SESSION_COOKIE, found.renewed, { secure: secure(req), maxAgeSec: SESSION_TTL_MS / 1000 }) };
        }
        return String(req.headers.accept ?? "").includes("text/html") ? { kind: "login" } : unauthorized;
    }

    const loginOptions = (next: string | undefined): LoginOptions => ({
        password: password !== undefined,
        token: o.token !== "",
        ...(oidc ? { oidcHost: oidc.host } : {}),
        errorText: REFUSED,
        ...(next && next !== DEFAULT_NEXT ? { next } : {}),
    });

    /** The login page with `message` as its error, for a status that is not the generic redirect. */
    const refusedPage = (res: ServerResponse, status: number, message: string, next: string, headers: Record<string, string | string[]> = {}): void =>
        page(res, status, loginPage(true, false, { ...loginOptions(next), errorText: message }), headers);

    /** A form post must come from a page of this host: a browser always names the origin of a cross-site POST. */
    const fromOurPage = (req: IncomingMessage): boolean => {
        const origin = req.headers.origin;
        if (origin !== undefined) return sameOrigin(req) || (o.publicOrigin !== undefined && origin === o.publicOrigin);
        const site = req.headers["sec-fetch-site"];
        return site === undefined || site === "same-origin" || site === "none";
    };

    async function signInForm(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!fromOurPage(req)) return json(res, 403, { error: "Cross-site sign-in refused." });
        if (!password && !o.token) return json(res, 404, { error: "Not found" });
        if (!transportOk(req)) return refusedPage(res, 403, OVER_HTTPS, DEFAULT_NEXT);
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) {
            const retry = Math.max(1, Math.ceil(wait / 1000));
            return refusedPage(res, 429, `Too many attempts. Try again in ${retry} second${retry === 1 ? "" : "s"}.`, DEFAULT_NEXT, {
                "retry-after": String(retry),
            });
        }
        let form: URLSearchParams;
        try {
            form = new URLSearchParams(await readBody(req, MAX_FORM));
        } catch {
            return json(res, 413, { error: "Request too large" });
        }
        const next = safeNext(form.get("next"));
        const token = form.get("token") ?? "";
        let signedIn: { method: Method; subject: string } | undefined;
        if (token !== "") {
            if (o.token && tokenMatches(token, o.token)) signedIn = { method: "token", subject: "token" };
        } else if (password) {
            const user = form.get("user") ?? "";
            if (await password.check(user, form.get("password") ?? "")) signedIn = { method: "password", subject: user };
        }
        if (!signedIn) {
            refuse(token !== "" ? "token" : "password", req);
            return see(res, `/app/login?error=1${next === DEFAULT_NEXT ? "" : `&next=${encodeURIComponent(next)}`}`);
        }
        limiter.succeed(clientAddress(req));
        see(res, next, { "set-cookie": sessionCookie(req, signedIn.method, signedIn.subject) });
    }

    async function startOidc(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (!oidc) return json(res, 404, { error: "Not found" });
        const next = safeNext(url.searchParams.get("next"));
        try {
            const begun = await oidc.begin();
            const record = sessions.flow({ state: begun.state, nonce: begun.nonce, verifier: begun.verifier, next });
            res.writeHead(302, {
                location: begun.location,
                "cache-control": "no-store",
                "set-cookie": cookieHeader(FLOW_COOKIE, record, { secure: secure(req), maxAgeSec: FLOW_TTL_MS / 1000, path: FLOW_COOKIE_PATH }),
            });
            res.end();
        } catch (err) {
            log(`[web] OIDC could not start: ${err instanceof OidcError ? err.detail : "the provider could not be reached"}`);
            refusedPage(res, 502, OIDC_FAILED, next);
        }
    }

    async function finishOidc(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (!oidc) return json(res, 404, { error: "Not found" });
        const flow = sessions.openFlow(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
        // The record is single use: gone from the browser whatever happens next.
        const clear = cookieHeader(FLOW_COOKIE, "", { secure: secure(req), maxAgeSec: 0, path: FLOW_COOKIE_PATH });
        if (!flow) return refusedPage(res, 400, OIDC_EXPIRED, DEFAULT_NEXT, { "set-cookie": clear });
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (url.searchParams.has("error") || code === "" || code.length > 2048) {
            log("[web] OIDC sign-in ended at the provider without a code");
            return refusedPage(res, 403, OIDC_FAILED, flow.next, { "set-cookie": clear });
        }
        if (!tokenMatches(state, flow.state)) {
            log("[web] OIDC sign-in refused: state does not match");
            return refusedPage(res, 400, OIDC_FAILED, flow.next, { "set-cookie": clear });
        }
        try {
            const who = await oidc.complete(code, flow.verifier, flow.nonce);
            see(res, safeNext(flow.next), { "set-cookie": [clear, sessionCookie(req, "oidc", who.subject)] });
        } catch (err) {
            const denied = err instanceof OidcError && err.kind === "denied";
            log(`[web] OIDC sign-in refused: ${err instanceof OidcError ? err.detail : "the provider could not be reached"}`);
            refusedPage(res, denied ? 403 : 502, denied ? NOT_ALLOWED : OIDC_FAILED, flow.next, { "set-cookie": clear });
        }
    }

    const noStoreJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
        res.end(JSON.stringify(body));
    };
    const cookieMethod = (m: SignedIn["method"] | undefined): m is Method => m === "token" || m === "password" || m === "oidc";

    /** `GET /app/auth/info`, public: what a desktop app asks before it offers browser sign-in. Nothing secret. */
    const authInfo = (res: ServerResponse): void =>
        noStoreJson(res, 200, { app: "pikvm-desktop", device: true, methods: [o.token ? "token" : "", password ? "password" : "", oidc ? "oidc" : ""].filter(Boolean) });

    /** The request a desktop app made, checked: a loopback port it can listen on, a state, a PKCE challenge and a name. */
    function deviceRequest(params: URLSearchParams): { port: number; state: string; challenge: string; name: string } | undefined {
        const port = Number(params.get("port"));
        const state = params.get("state") ?? "";
        const challenge = params.get("challenge") ?? "";
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || !STATE.test(state) || !CHALLENGE.test(challenge)) return undefined;
        return { port, state, challenge, name: cleanDeviceName(params.get("name")) };
    }
    /** Where the browser goes back to: the app's own listener, on this machine only. */
    const loopbackCallback = (port: number, query: Record<string, string>): string => `http://127.0.0.1:${port}/callback?${new URLSearchParams(query).toString()}`;

    /** `GET /app/auth/device`: the question. Only a browser signed in by a cookie can be asked: a header credential has no one in front of it. */
    function askDevice(res: ServerResponse, url: URL, signedIn: SignedIn | undefined): void {
        const request = deviceRequest(url.searchParams);
        if (!request) return page(res, 400, devicePageError("This sign-in link is not valid."));
        if (!signedIn || !cookieMethod(signedIn.method)) return page(res, 403, devicePageError("Open this link in a browser where you are signed in."));
        const grant = sessions.seal("device-grant", { ...request, subject: signedIn.subject, method: signedIn.method, exp: now() + FLOW_TTL_MS });
        page(res, 200, consentPage({ name: request.name, subject: signedIn.subject, grant }));
    }

    /** `POST /app/auth/device`: the answer. What is being allowed comes from the sealed grant, never from a form field. */
    async function answerDevice(req: IncomingMessage, res: ServerResponse, signedIn: SignedIn | undefined): Promise<void> {
        if (!fromOurPage(req)) return json(res, 403, { error: "Cross-site request refused." });
        if (!signedIn || !cookieMethod(signedIn.method)) return page(res, 403, devicePageError("Open this link in a browser where you are signed in."));
        let form: URLSearchParams;
        try {
            form = new URLSearchParams(await readBody(req, MAX_FORM));
        } catch {
            return json(res, 413, { error: "Request too large" });
        }
        const grant = sessions.open("device-grant", form.get("grant") ?? "") as
            | { port?: number; state?: string; challenge?: string; name?: string; subject?: string; method?: string; exp?: number }
            | undefined;
        const valid =
            grant !== undefined && typeof grant === "object" && typeof grant.port === "number" && typeof grant.state === "string" && typeof grant.challenge === "string" &&
            typeof grant.name === "string" && typeof grant.subject === "string" && typeof grant.method === "string" && typeof grant.exp === "number" && grant.exp > now();
        if (!valid) return page(res, 400, devicePageError("That sign-in expired. Start again from PiKVM Desktop."));
        // The page was shown to this person; only they may answer it.
        if (grant.subject !== signedIn.subject || grant.method !== signedIn.method) return page(res, 403, devicePageError("That sign-in was started by someone else."));
        const { port, state, challenge, name, subject, method } = grant as { port: number; state: string; challenge: string; name: string; subject: string; method: Method };
        if (form.get("decision") !== "allow") return see(res, loopbackCallback(port, { error: "access_denied", state }));
        const code = codes.issue({ challenge, name, method, subject });
        see(res, loopbackCallback(port, { code, state }));
    }

    // MCP clients (Claude Code, Codex and the like) sign in with OAuth 2.1 as the MCP specification describes it: discovery documents, dynamic
    // client registration, an authorization code with PKCE, and a token. It ends in the same revocable device token a desktop app gets, shown in
    // Settings, Account, so there is one list to revoke from. A client's registration is not stored: its `client_id` is sealed with the session
    // key and carries the redirect URIs and the name, so a restart forgets nothing and nothing here can be guessed or altered.

    /** The origin a client reaches this host at: the configured public URL, else the request's own. */
    const originOf = (req: IncomingMessage): string => o.publicOrigin ?? `${secure(req) ? "https" : "http"}://${String(req.headers.host ?? "localhost")}`;

    /** `GET /.well-known/oauth-protected-resource[/app/mcp]`, public: which authorization server protects the MCP endpoint (RFC 9728). */
    function protectedResource(req: IncomingMessage, res: ServerResponse): void {
        const origin = originOf(req);
        noStoreJson(res, 200, { resource: `${origin}${MCP_PATH}`, authorization_servers: [origin], bearer_methods_supported: ["header"] });
    }

    /** `GET /.well-known/oauth-authorization-server`, public (RFC 8414). Public clients only, PKCE S256 only. */
    function authorizationServer(req: IncomingMessage, res: ServerResponse): void {
        const origin = originOf(req);
        noStoreJson(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/app/oauth/authorize`,
            token_endpoint: `${origin}/app/oauth/token`,
            registration_endpoint: `${origin}/app/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
    }

    /** RFC 8707 `resource`: absent, or this host's MCP endpoint (a trailing slash is the same resource). */
    const resourceOk = (raw: string | null | undefined, req: IncomingMessage): boolean => raw == null || raw === "" || raw.replace(/\/$/, "") === `${originOf(req)}${MCP_PATH}`;

    /** A redirect URI a client may register: https, or http to this machine, with no fragment and no credentials. */
    function acceptableRedirect(raw: unknown): raw is string {
        if (typeof raw !== "string" || raw.length > 300) return false;
        let u: URL;
        try {
            u = new URL(raw);
        } catch {
            return false;
        }
        if (u.hash !== "" || u.username !== "" || u.password !== "") return false;
        if (u.protocol === "https:") return true;
        return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
    }

    /** `POST /app/oauth/register`, public (RFC 7591): a client says what it is and where it returns to; it gets a `client_id` and no secret. */
    async function oauthRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!transportOk(req)) return noStoreJson(res, 403, { error: "invalid_request", error_description: OVER_HTTPS });
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return noStoreJson(res, 429, { error: "slow_down" }, { "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) });
        let body: { redirect_uris?: unknown; client_name?: unknown };
        try {
            body = JSON.parse(await readBody(req, MAX_FORM)) as typeof body;
        } catch {
            return noStoreJson(res, 400, { error: "invalid_client_metadata" });
        }
        const uris = body.redirect_uris;
        if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(acceptableRedirect)) {
            return noStoreJson(res, 400, { error: "invalid_redirect_uri", error_description: "Use an https address, or http to 127.0.0.1 or localhost." });
        }
        const name = cleanDeviceName(typeof body.client_name === "string" ? body.client_name : "MCP client");
        const clientId = sessions.seal("oauth-client", { n: name, r: uris });
        noStoreJson(res, 201, {
            client_id: clientId,
            client_name: name,
            redirect_uris: uris,
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        });
    }

    const openClient = (id: unknown): { n: string; r: string[] } | undefined => {
        const c = sessions.open("oauth-client", typeof id === "string" ? id : undefined) as { n?: unknown; r?: unknown } | undefined;
        return c && typeof c.n === "string" && Array.isArray(c.r) && c.r.every((x) => typeof x === "string") ? { n: c.n, r: c.r as string[] } : undefined;
    };

    /** Back to the client with an error, as RFC 6749 4.1.2.1 says, once its redirect URI is known to be one it registered. */
    const backWith = (res: ServerResponse, redirectUri: string, query: Record<string, string>): void => {
        const u = new URL(redirectUri);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
        see(res, u.toString());
    };

    const OAUTH_STATE = /^[\x21-\x7e]{1,512}$/;

    /** `GET /app/oauth/authorize`: the question, for a browser signed in by a cookie. */
    function oauthAsk(req: IncomingMessage, res: ServerResponse, url: URL, signedIn: SignedIn | undefined): void {
        const p = url.searchParams;
        const client = openClient(p.get("client_id"));
        const redirectUri = p.get("redirect_uri") ?? (client?.r.length === 1 ? client.r[0] : undefined);
        // Until the redirect URI is known to be the client's own, nothing goes back to it: the error is shown here.
        if (!client || !redirectUri || !client.r.includes(redirectUri)) return page(res, 400, devicePageError("This sign-in link is not valid."));
        const state = p.get("state") ?? "";
        const challenge = p.get("code_challenge") ?? "";
        // RFC 8707: a client names the resource it wants a token for. Only this host's MCP endpoint is offered.
        if (!resourceOk(p.get("resource"), req)) return backWith(res, redirectUri, { error: "invalid_target", ...(state ? { state } : {}) });
        if (p.get("response_type") !== "code") return backWith(res, redirectUri, { error: "unsupported_response_type", ...(state ? { state } : {}) });
        if (!CHALLENGE.test(challenge) || p.get("code_challenge_method") !== "S256" || (state !== "" && !OAUTH_STATE.test(state))) {
            return backWith(res, redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required.", ...(state ? { state } : {}) });
        }
        if (!signedIn || !cookieMethod(signedIn.method)) return page(res, 403, devicePageError("Open this link in a browser where you are signed in."));
        const grant = sessions.seal("oauth-grant", { c: client.n, u: redirectUri, s: state, ch: challenge, sub: signedIn.subject, m: signedIn.method, exp: now() + FLOW_TTL_MS });
        const to = new URL(redirectUri);
        page(res, 200, consentPage({ name: client.n, subject: signedIn.subject, grant, client: { app: client.n, returnsTo: to.host, action: "/app/oauth/authorize" } }));
    }

    /** `POST /app/oauth/authorize`: the answer. What is allowed comes from the sealed grant, never from a form field. */
    async function oauthAnswer(req: IncomingMessage, res: ServerResponse, signedIn: SignedIn | undefined): Promise<void> {
        if (!fromOurPage(req)) return json(res, 403, { error: "Cross-site request refused." });
        if (!signedIn || !cookieMethod(signedIn.method)) return page(res, 403, devicePageError("Open this link in a browser where you are signed in."));
        let form: URLSearchParams;
        try {
            form = new URLSearchParams(await readBody(req, MAX_FORM));
        } catch {
            return json(res, 413, { error: "Request too large" });
        }
        const g = sessions.open("oauth-grant", form.get("grant") ?? "") as { c?: string; u?: string; s?: string; ch?: string; sub?: string; m?: string; exp?: number } | undefined;
        if (!g || typeof g.c !== "string" || typeof g.u !== "string" || typeof g.s !== "string" || typeof g.ch !== "string" || typeof g.sub !== "string" || typeof g.m !== "string" || typeof g.exp !== "number" || g.exp <= now()) {
            return page(res, 400, devicePageError("That sign-in expired. Start again from the app."));
        }
        if (g.sub !== signedIn.subject || g.m !== signedIn.method) return page(res, 403, devicePageError("That sign-in was started by someone else."));
        const state = g.s ? { state: g.s } : {};
        if (form.get("decision") !== "allow") return backWith(res, g.u, { error: "access_denied", ...state });
        const code = codes.issue({ challenge: g.ch, name: `${g.c} (MCP)`, method: g.m as Method, subject: g.sub, redirectUri: g.u });
        backWith(res, g.u, { code, ...state });
    }

    /** `POST /app/oauth/token`, public: the code and the verifier for a device token, as a form (RFC 6749) or JSON. */
    async function oauthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!transportOk(req)) return noStoreJson(res, 403, { error: "invalid_request", error_description: OVER_HTTPS });
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return noStoreJson(res, 429, { error: "slow_down" }, { "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) });
        let fields: Record<string, string>;
        try {
            const raw = await readBody(req, MAX_FORM);
            fields = String(req.headers["content-type"] ?? "").startsWith("application/json")
                ? Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
                : Object.fromEntries(new URLSearchParams(raw));
        } catch {
            return noStoreJson(res, 400, { error: "invalid_request" });
        }
        if (fields.grant_type !== "authorization_code") return noStoreJson(res, 400, { error: "unsupported_grant_type" });
        if (!resourceOk(fields.resource, req)) return noStoreJson(res, 400, { error: "invalid_target" });
        const grant = fields.code && fields.code_verifier ? codes.redeem(fields.code, fields.code_verifier) : undefined;
        const binding = grant ? bindingOf(grant.method) : undefined;
        // The code was made for one redirect URI; a client that asks with another is somebody else.
        if (!grant || binding === undefined || grant.redirectUri === undefined || grant.redirectUri !== fields.redirect_uri) {
            refuse("oauth code", req);
            return noStoreJson(res, 400, { error: "invalid_grant" });
        }
        limiter.succeed(clientAddress(req));
        const issued = devices.issue(grant.name, grant.method, grant.subject, binding, "mcp");
        log(`[web] MCP client "${issued.device.name}" signed in as ${grant.subject} (${grant.method})`);
        noStoreJson(res, 200, { access_token: issued.token, token_type: "Bearer" });
    }

    /** `POST /app/auth/device/token`, public: the code and the verifier for a device token. The token is shown here and nowhere else. */
    async function deviceToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!transportOk(req)) return noStoreJson(res, 403, { error: OVER_HTTPS });
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return noStoreJson(res, 429, { error: "Too many attempts. Try again later." }, { "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) });
        let body: { code?: unknown; verifier?: unknown };
        try {
            body = JSON.parse(await readBody(req, MAX_FORM)) as { code?: unknown; verifier?: unknown };
        } catch {
            return noStoreJson(res, 400, { error: "That code is not valid." });
        }
        const grant = typeof body.code === "string" && typeof body.verifier === "string" ? codes.redeem(body.code, body.verifier) : undefined;
        const binding = grant ? bindingOf(grant.method) : undefined;
        if (!grant || binding === undefined) {
            refuse("device code", req);
            return noStoreJson(res, 400, { error: "That code is not valid." });
        }
        limiter.succeed(clientAddress(req));
        const issued = devices.issue(grant.name, grant.method, grant.subject, binding);
        log(`[web] device "${issued.device.name}" signed in as ${grant.subject} (${grant.method})`);
        noStoreJson(res, 200, { token: issued.token, id: issued.device.id, name: issued.device.name, subject: issued.device.subject });
    }

    /** `GET /app/api/v1/devices`: the signed-in apps, for Settings, Account. A device cannot list the others. */
    function listDevices(res: ServerResponse, signedIn: SignedIn | undefined): void {
        if (!signedIn || signedIn.method === "device") return noStoreJson(res, 403, { error: "Not allowed." });
        noStoreJson(res, 200, { devices: devices.list() });
    }

    /** `DELETE /app/api/v1/devices/:id`: remove one. `self` is the device removing its own token (it was forgotten in the app). */
    function revokeDevice(res: ServerResponse, id: string, signedIn: SignedIn | undefined): void {
        if (!signedIn) return noStoreJson(res, 401, { error: "Unauthorized" });
        if (id === "self") {
            if (signedIn.method !== "device" || !signedIn.deviceId) return noStoreJson(res, 404, { error: "Not found" });
            devices.revoke(signedIn.deviceId);
            return noStoreJson(res, 200, { ok: true });
        }
        if (signedIn.method === "device") return noStoreJson(res, 403, { error: "Not allowed." });
        const removed = devices.revoke(id);
        noStoreJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Not found" });
    }

    return {
        methods,

        resourceMetadata: (req) => `${originOf(req)}/.well-known/oauth-protected-resource${MCP_PATH}`,

        async judge(req, path) {
            if (isPublicPath(path)) return { kind: "allow" };
            const header = String(req.headers.authorization ?? "");
            if (header.startsWith("Bearer ")) return bearer(req, path);
            if (header.startsWith("Basic ")) return basic(req);
            return cookie(req);
        },

        loginRedirect(url) {
            const next = safeNext(url.pathname + url.search);
            return next === DEFAULT_NEXT || url.pathname === "/" ? "/app/login" : `/app/login?next=${encodeURIComponent(next)}`;
        },

        handles(method, path) {
            if (path === "/app/logout") return true;
            if (path === "/app/login" || path === "/app/auth/callback" || path === "/app/auth/info") return method === "GET";
            if (path === "/app/auth/device") return method === "GET" || method === "POST";
            if (path === "/app/auth/device/token") return method === "POST";
            if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${MCP_PATH}` || path === "/.well-known/oauth-authorization-server") return method === "GET";
            if (path === "/app/oauth/register" || path === "/app/oauth/token") return method === "POST";
            if (path === "/app/oauth/authorize") return method === "GET" || method === "POST";
            if (path === "/app/api/v1/devices") return method === "GET";
            if (/^\/app\/api\/v1\/devices\/(?:self|[0-9a-f]{12})$/.test(path)) return method === "DELETE";
            return path === "/app/auth" && (method === "GET" || method === "POST");
        },

        async handle(req, res, url, signedIn) {
            const path = url.pathname;
            if (path === "/app/login") {
                const next = safeNext(url.searchParams.get("next"));
                return page(res, 200, loginPage(url.searchParams.get("error") === "1", url.searchParams.get("bye") === "1", loginOptions(next)));
            }
            if (path === "/app/logout") {
                return see(res, "/app/login?bye=1", { "set-cookie": cookieHeader(SESSION_COOKIE, "", { secure: secure(req), maxAgeSec: 0 }) });
            }
            if (path === "/app/auth/callback") return finishOidc(req, res, url);
            if (path === "/.well-known/oauth-authorization-server") return authorizationServer(req, res);
            if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResource(req, res);
            if (path === "/app/oauth/register") return oauthRegister(req, res);
            if (path === "/app/oauth/token") return oauthToken(req, res);
            if (path === "/app/oauth/authorize") return req.method === "POST" ? oauthAnswer(req, res, signedIn) : oauthAsk(req, res, url, signedIn);
            if (path === "/app/auth/info") return authInfo(res);
            if (path === "/app/auth/device") return req.method === "POST" ? answerDevice(req, res, signedIn) : askDevice(res, url, signedIn);
            if (path === "/app/auth/device/token") return deviceToken(req, res);
            if (path === "/app/api/v1/devices") return listDevices(res, signedIn);
            if (path.startsWith("/app/api/v1/devices/")) return revokeDevice(res, path.slice("/app/api/v1/devices/".length), signedIn);
            if (req.method === "POST") return signInForm(req, res);
            return startOidc(req, res, url);
        },
    };
}
