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
const MAX_FORM = 8192;

/** Who a request is, once let in: how it got in and who it is. Never a secret. Only a cookie session (token, password,
 *  oidc) can be signed out of; a bearer or Basic header has no session. */
export interface SignedIn {
    method: Method | "bearer" | "basic";
    subject: string;
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
    handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
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

    async function bearer(req: IncomingMessage): Promise<Verdict> {
        const wait = limiter.wait(clientAddress(req));
        if (wait > 0) return tooMany(wait);
        const verdict = bearerVerdict(req, { token: o.token, allowHttp: o.allowHttpBearer, secureTransport: transportOk });
        if (verdict === "allow") {
            limiter.succeed(clientAddress(req));
            return { kind: "allow", signedIn: { method: "bearer", subject: "access token" } };
        }
        // Only a wrong token counts as a failed guess; a refusal for the Origin or the transport says nothing about it.
        const presented = String(req.headers.authorization ?? "").slice("Bearer ".length);
        if (o.token && !tokenMatches(presented, o.token)) refuse("bearer", req);
        return unauthorized;
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

    return {
        methods,

        async judge(req, path) {
            if (isPublicPath(path)) return { kind: "allow" };
            const header = String(req.headers.authorization ?? "");
            if (header.startsWith("Bearer ")) return bearer(req);
            if (header.startsWith("Basic ")) return basic(req);
            return cookie(req);
        },

        loginRedirect(url) {
            const next = safeNext(url.pathname + url.search);
            return next === DEFAULT_NEXT || url.pathname === "/" ? "/app/login" : `/app/login?next=${encodeURIComponent(next)}`;
        },

        handles(method, path) {
            if (path === "/app/logout") return true;
            if (path === "/app/login" || path === "/app/auth/callback") return method === "GET";
            return path === "/app/auth" && (method === "GET" || method === "POST");
        },

        async handle(req, res, url) {
            const path = url.pathname;
            if (path === "/app/login") {
                const next = safeNext(url.searchParams.get("next"));
                return page(res, 200, loginPage(url.searchParams.get("error") === "1", url.searchParams.get("bye") === "1", loginOptions(next)));
            }
            if (path === "/app/logout") {
                return see(res, "/app/login?bye=1", { "set-cookie": cookieHeader(SESSION_COOKIE, "", { secure: secure(req), maxAgeSec: 0 }) });
            }
            if (path === "/app/auth/callback") return finishOidc(req, res, url);
            if (req.method === "POST") return signInForm(req, res);
            return startOidc(req, res, url);
        },
    };
}
