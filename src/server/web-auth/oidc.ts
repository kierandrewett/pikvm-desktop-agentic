/**
 * The OpenID Connect method, with no proxy in front: this host is the relying party.
 *
 * Authorization code flow with PKCE (S256), `state` and `nonce`. The browser is sent to the provider's authorization
 * endpoint; the provider comes back to `<PIKVM_PUBLIC_URL>/app/auth/callback` with a code; this host exchanges it at the
 * token endpoint and checks the `id_token` with `jose` (signature against the issuer's JWKS, algorithm in an allow list,
 * issuer, audience, expiry, not-before, nonce). Only then do the allow rules run: a user passes when their `groups`
 * claim holds one of PIKVM_OIDC_ALLOWED_GROUPS, or their `email` is in PIKVM_OIDC_ALLOWED_EMAILS and the provider
 * says `email_verified: true`, or their `sub` is in PIKVM_OIDC_ALLOWED_SUBJECTS. With all three lists empty nobody passes.
 *
 * The id_token is the whole source of identity: nothing is read from userinfo, and neither it nor the access token is kept.
 * Provider URLs from the discovery document are held to the same rule as the issuer (https, or http to loopback only).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Only these ever verify an id_token: `none` and every HMAC algorithm are out. */
export const ID_TOKEN_ALGORITHMS = ["RS256", "ES256", "EdDSA"];
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_BODY = 1_000_000;

export interface OidcConfig {
    issuer: string;
    clientId: string;
    /** Empty: a public client, PKCE only. */
    clientSecret: string;
    scopes: string;
    allowedGroups: string[];
    allowedEmails: string[];
    /** `sub` values, exact match. For a provider that sends neither groups nor a verified email. */
    allowedSubjects: string[];
    /** `<PIKVM_PUBLIC_URL>/app/auth/callback` */
    redirectUri: string;
}

/** Why a sign-in was refused. `kind` decides what the user is told; `detail` is for the log and holds no secret. */
export class OidcError extends Error {
    constructor(
        readonly kind: "failed" | "denied",
        readonly detail: string,
    ) {
        super(detail);
    }
}

export interface OidcOptions {
    now: () => number;
    /** Test seam. */
    fetch?: typeof fetch;
    /** How soon the key set may be fetched again after an id_token names a key it does not hold. */
    jwksCooldownMs?: number;
}

interface Discovery {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    /** Whether the token endpoint takes the client secret in the body rather than a Basic header. */
    secretInBody: boolean;
    fetchedAt: number;
}

export interface Begun {
    /** Where to send the browser. */
    location: string;
    state: string;
    nonce: string;
    verifier: string;
}

export interface Identity {
    subject: string;
    email: string | undefined;
}

const isLoopbackHost = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** https, or http to this machine (a provider run for a test). */
export function acceptableUrl(value: string): boolean {
    try {
        const u = new URL(value);
        if (u.username || u.password) return false;
        return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
    } catch {
        return false;
    }
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();
const sameText = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

export class OidcClient {
    private discovery: Discovery | undefined;
    private jwks: JWTVerifyGetKey | undefined;
    private readonly http: typeof fetch;

    constructor(
        readonly config: OidcConfig,
        private readonly opts: OidcOptions,
    ) {
        this.http = opts.fetch ?? fetch;
    }

    /** The provider's host, for the sign-in button. */
    get host(): string {
        return new URL(this.config.issuer).host;
    }

    private async getJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
        const res = await this.http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const text = await res.text();
        if (text.length > MAX_BODY) throw new OidcError("failed", "the provider's answer is too large");
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            throw new OidcError("failed", `the provider answered ${res.status} with something that is not JSON`);
        }
        if (!res.ok || !body || typeof body !== "object" || Array.isArray(body)) {
            throw new OidcError("failed", `the provider answered ${res.status}`);
        }
        return body as Record<string, unknown>;
    }

    private async discover(): Promise<Discovery> {
        if (this.discovery && this.opts.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) return this.discovery;
        const doc = await this.getJson(`${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
            headers: { accept: "application/json" },
        });
        // A document that names another issuer is not this provider's (and could redirect sign-ins to a stranger).
        if (doc["issuer"] !== this.config.issuer) throw new OidcError("failed", "the discovery document names another issuer");
        const endpoint = (key: string): string => {
            const value = doc[key];
            if (typeof value !== "string" || !acceptableUrl(value)) throw new OidcError("failed", `discovery: ${key} is missing or not https`);
            return value;
        };
        const methods = doc["token_endpoint_auth_methods_supported"];
        const secretInBody =
            Array.isArray(methods) && !methods.includes("client_secret_basic") && methods.includes("client_secret_post");
        const next: Discovery = {
            authorizationEndpoint: endpoint("authorization_endpoint"),
            tokenEndpoint: endpoint("token_endpoint"),
            jwksUri: endpoint("jwks_uri"),
            secretInBody,
            fetchedAt: this.opts.now(),
        };
        if (!this.jwks || this.discovery?.jwksUri !== next.jwksUri) {
            // jose caches the key set and fetches it again, at most once per cooldown, when a token names a key it lacks.
            this.jwks = createRemoteJWKSet(new URL(next.jwksUri), {
                cooldownDuration: this.opts.jwksCooldownMs ?? 30_000,
                timeoutDuration: REQUEST_TIMEOUT_MS,
            });
        }
        this.discovery = next;
        return next;
    }

    /** Start a sign-in: where to send the browser, and what to remember (in a cookie) to finish it. */
    async begin(): Promise<Begun> {
        const d = await this.discover();
        const state = randomBytes(24).toString("base64url");
        const nonce = randomBytes(24).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const url = new URL(d.authorizationEndpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", this.config.clientId);
        url.searchParams.set("redirect_uri", this.config.redirectUri);
        url.searchParams.set("scope", this.config.scopes);
        url.searchParams.set("state", state);
        url.searchParams.set("nonce", nonce);
        url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
        url.searchParams.set("code_challenge_method", "S256");
        return { location: url.href, state, nonce, verifier };
    }

    /** Finish a sign-in: the code for an id_token, the id_token checked, the user checked against the allow rules. */
    async complete(code: string, verifier: string, nonce: string): Promise<Identity> {
        const d = await this.discover();
        const idToken = await this.exchange(d, code, verifier);
        const claims = await this.verify(idToken, nonce);
        return this.admit(claims);
    }

    private async exchange(d: Discovery, code: string, verifier: string): Promise<string> {
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: this.config.redirectUri,
            client_id: this.config.clientId,
            code_verifier: verifier,
        });
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
        if (this.config.clientSecret) {
            if (d.secretInBody) body.set("client_secret", this.config.clientSecret);
            else {
                const basic = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
                headers["authorization"] = `Basic ${Buffer.from(basic).toString("base64")}`;
            }
        }
        const reply = await this.getJson(d.tokenEndpoint, { method: "POST", headers, body: body.toString() });
        const idToken = reply["id_token"];
        if (typeof idToken !== "string" || idToken === "") throw new OidcError("failed", "the token endpoint sent no id_token");
        return idToken;
    }

    private async verify(idToken: string, nonce: string): Promise<JWTPayload> {
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, this.jwks!, {
                issuer: this.config.issuer,
                audience: this.config.clientId,
                algorithms: ID_TOKEN_ALGORITHMS,
                clockTolerance: CLOCK_SKEW_SECONDS,
                currentDate: new Date(this.opts.now()),
                requiredClaims: ["sub", "exp"],
            }));
        } catch (err) {
            // Only the error's class and the claim it names are kept: never the token.
            const code = err instanceof errors.JOSEError ? err.code : "ERR_UNKNOWN";
            const claim = err instanceof errors.JWTClaimValidationFailed ? ` (${err.claim})` : "";
            throw new OidcError("failed", `the id_token was refused: ${code}${claim}`);
        }
        if (typeof payload["nonce"] !== "string" || !sameText(payload["nonce"], nonce)) {
            throw new OidcError("failed", "the id_token's nonce does not match");
        }
        // With several audiences the token must also say it was issued to this client.
        if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload["azp"] !== this.config.clientId) {
            throw new OidcError("failed", "the id_token has several audiences and is not issued to this client");
        }
        return payload;
    }

    private admit(claims: JWTPayload): Identity {
        const email = typeof claims["email"] === "string" ? claims["email"] : undefined;
        const raw = claims["groups"];
        const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : typeof raw === "string" ? [raw] : [];
        const byGroup = groups.some((g) => this.config.allowedGroups.includes(g));
        // An address counts only when the provider says it checked it: `email_verified` must be the boolean true. A claim
        // that is missing, false or a string ("true") is not verification, and the email rule then does not pass.
        const byEmail =
            email !== undefined && claims["email_verified"] === true && this.config.allowedEmails.includes(email.toLowerCase());
        const bySubject = this.config.allowedSubjects.includes(claims.sub!);
        if (!byGroup && !byEmail && !bySubject) {
            throw new OidcError("denied", "the user is in none of the allowed groups, subjects or verified emails");
        }
        return { subject: claims.sub!, email };
    }
}
