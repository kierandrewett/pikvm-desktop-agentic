/**
 * The web host's sign-in, from its environment (src/web-server.ts passes `process.env`).
 *
 * A method is on when its variables are present; any combination works. With none on, the host serves only on
 * loopback and refuses any other HOST (`bindProblem`), and there is no sign-in at all, as there was never one.
 *
 *   access token   PIKVM_ACCESS_TOKEN, PIKVM_SYNC_ALLOW_HTTP
 *   password       PIKVM_LOGIN_USER with PIKVM_LOGIN_PASSWORD_HASH or PIKVM_LOGIN_PASSWORD
 *   OIDC           PIKVM_OIDC_ISSUER, PIKVM_OIDC_CLIENT_ID, PIKVM_OIDC_CLIENT_SECRET, PIKVM_OIDC_SCOPES,
 *                  PIKVM_OIDC_ALLOWED_GROUPS, PIKVM_OIDC_ALLOWED_EMAILS, PIKVM_OIDC_ALLOWED_SUBJECTS, and PIKVM_PUBLIC_URL
 *   every method   PIKVM_PUBLIC_URL, PIKVM_TRUST_PROXY, PIKVM_SESSION_SECRET
 */

import { resolve } from "node:path";
import { createWebAuth, type WebAuth, type WebAuthOptions } from "./index";
import { acceptableUrl, type OidcConfig } from "./oidc";
import { parseHash } from "./password";
import { loadSessionKey } from "./session";

export interface WebAuthSetup {
    /** Undefined when no method is configured. */
    auth: WebAuth | undefined;
    /** Things worth saying at startup that are not errors. */
    warnings: string[];
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

/** Why this HOST may not be bound, or undefined when it may. */
export function bindProblem(host: string, anyMethod: boolean): string | undefined {
    if (anyMethod || LOOPBACK_HOSTS.includes(host)) return undefined;
    return (
        `HOST=${host} would expose the KVM with no sign-in. Configure at least one method: ` +
        "PIKVM_ACCESS_TOKEN (access token); PIKVM_LOGIN_USER with PIKVM_LOGIN_PASSWORD_HASH or PIKVM_LOGIN_PASSWORD (password); " +
        "or PIKVM_OIDC_ISSUER, PIKVM_OIDC_CLIENT_ID and PIKVM_PUBLIC_URL (OpenID Connect)."
    );
}

/** Is any sign-in method configured? Cheap, so the caller can pick HOST before it builds anything. */
export function anyMethod(env: (name: string) => string): boolean {
    return env("PIKVM_ACCESS_TOKEN") !== "" || env("PIKVM_LOGIN_USER") !== "" || env("PIKVM_OIDC_ISSUER") !== "";
}

const list = (text: string): string[] =>
    text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

/** Build the sign-in from the environment. Throws an Error whose message says what to fix (and holds no secret). */
export function webAuthFromEnv(env: (name: string) => string, dataDir: string, seams: Partial<WebAuthOptions> = {}): WebAuthSetup {
    const warnings: string[] = [];
    const token = env("PIKVM_ACCESS_TOKEN");

    const user = env("PIKVM_LOGIN_USER");
    const hash = env("PIKVM_LOGIN_PASSWORD_HASH");
    const plain = env("PIKVM_LOGIN_PASSWORD");
    if ((hash || plain) && !user) throw new Error("PIKVM_LOGIN_PASSWORD_HASH / PIKVM_LOGIN_PASSWORD need PIKVM_LOGIN_USER");
    if (user && !hash && !plain) throw new Error("PIKVM_LOGIN_USER needs PIKVM_LOGIN_PASSWORD_HASH (or PIKVM_LOGIN_PASSWORD)");
    if (hash && plain) throw new Error("set PIKVM_LOGIN_PASSWORD_HASH or PIKVM_LOGIN_PASSWORD, not both");
    if (hash) parseHash(hash);
    if (plain) warnings.push("PIKVM_LOGIN_PASSWORD is a plain password in the environment; a hash (--hash-password) is better");

    const publicUrl = env("PIKVM_PUBLIC_URL");
    let publicOrigin: string | undefined;
    if (publicUrl) {
        let parsed: URL | undefined;
        try {
            parsed = new URL(publicUrl);
        } catch {
            /* handled below */
        }
        if (!parsed || !acceptableUrl(publicUrl) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
            throw new Error("PIKVM_PUBLIC_URL must be the origin users see, such as https://kvm.example.com (https, no path)");
        }
        publicOrigin = parsed.origin;
    }

    const issuer = env("PIKVM_OIDC_ISSUER");
    let oidc: OidcConfig | undefined;
    if (issuer) {
        if (!acceptableUrl(issuer)) throw new Error("PIKVM_OIDC_ISSUER must be an https URL");
        if (!env("PIKVM_OIDC_CLIENT_ID")) throw new Error("PIKVM_OIDC_ISSUER needs PIKVM_OIDC_CLIENT_ID");
        if (!publicOrigin) throw new Error("PIKVM_OIDC_ISSUER needs PIKVM_PUBLIC_URL (the redirect URI is <PIKVM_PUBLIC_URL>/app/auth/callback)");
        const scopes = list((env("PIKVM_OIDC_SCOPES") || "openid email profile groups").replace(/\s+/g, ","));
        if (!scopes.includes("openid")) scopes.unshift("openid");
        const allowedGroups = list(env("PIKVM_OIDC_ALLOWED_GROUPS"));
        const allowedEmails = list(env("PIKVM_OIDC_ALLOWED_EMAILS")).map((email) => email.toLowerCase());
        const allowedSubjects = list(env("PIKVM_OIDC_ALLOWED_SUBJECTS"));
        if (allowedGroups.length === 0 && allowedEmails.length === 0 && allowedSubjects.length === 0) {
            warnings.push(
                "PIKVM_OIDC_ALLOWED_GROUPS, PIKVM_OIDC_ALLOWED_EMAILS and PIKVM_OIDC_ALLOWED_SUBJECTS are all empty: every user the provider signs in will be refused",
            );
        }
        oidc = {
            issuer,
            clientId: env("PIKVM_OIDC_CLIENT_ID"),
            clientSecret: env("PIKVM_OIDC_CLIENT_SECRET"),
            scopes: scopes.join(" "),
            allowedGroups,
            allowedEmails,
            allowedSubjects,
            redirectUri: `${publicOrigin}/app/auth/callback`,
        };
    } else if (["CLIENT_ID", "CLIENT_SECRET", "SCOPES", "ALLOWED_GROUPS", "ALLOWED_EMAILS", "ALLOWED_SUBJECTS"].some((name) => env(`PIKVM_OIDC_${name}`))) {
        throw new Error("PIKVM_OIDC_* is set but PIKVM_OIDC_ISSUER is not");
    }

    if (!token && !user && !oidc) return { auth: undefined, warnings };

    const auth = createWebAuth({
        token,
        allowHttpBearer: env("PIKVM_SYNC_ALLOW_HTTP") === "1",
        ...(user ? { password: { user, secret: hash || plain, plain: !hash } } : {}),
        ...(oidc ? { oidc } : {}),
        ...(publicOrigin ? { publicOrigin } : {}),
        trustProxy: env("PIKVM_TRUST_PROXY") === "1",
        clientHosts: (env("PIKVM_OAUTH_CLIENT_HOSTS") ?? "").split(",").map((h) => h.trim()).filter(Boolean),
        sessionKey: loadSessionKey(env("PIKVM_SESSION_SECRET"), dataDir),
        devicesPath: resolve(dataDir, "devices.json"),
        ...seams,
    });
    return { auth, warnings };
}
