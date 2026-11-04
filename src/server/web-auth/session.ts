/**
 * Signed cookies for the web host: the session, and the short-lived record of an OpenID Connect sign-in in progress.
 *
 * A cookie is `base64url(JSON).base64url(HMAC-SHA256)`. The MAC covers a purpose label as well as the JSON, so a value
 * made for one use (the sign-in record) is worthless as another (the session). Nothing secret is inside: the value
 * says who signed in and how, and until when, and the key stays on the host.
 *
 * The key is PIKVM_SESSION_SECRET, or a random one made once and kept in <data dir>/session-secret so that sessions
 * survive a restart. Sessions last 30 days and are renewed (a new `iat`) when a request finds them more than a day old.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SESSION_COOKIE = "__pikvm_session";
/** The OpenID Connect sign-in record. Scoped to the sign-in paths, so it is never sent with an ordinary request. */
export const FLOW_COOKIE = "__pikvm_oidc";
export const FLOW_COOKIE_PATH = "/app/auth";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60_000;
export const FLOW_TTL_MS = 10 * 60_000;

export type Method = "token" | "password" | "oidc";

export interface Session {
    /** How the user signed in. */
    m: Method;
    /** Who: the user name, the OpenID subject, or "token". */
    s: string;
    /** What the method was configured with when this was made, as a MAC (see `Sessions.binding`). */
    b: string;
    /** Issued at, and valid until (ms since the epoch). */
    iat: number;
    exp: number;
}

export interface FlowRecord {
    state: string;
    nonce: string;
    verifier: string;
    next: string;
    exp: number;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

export class Sessions {
    constructor(
        private readonly key: Buffer,
        private readonly now: () => number,
    ) {}

    private mac(purpose: string, body: string): Buffer {
        return createHmac("sha256", this.key).update(`${purpose}\0${body}`).digest();
    }

    seal(purpose: string, value: object): string {
        const body = b64url(Buffer.from(JSON.stringify(value)));
        return `${body}.${b64url(this.mac(purpose, body))}`;
    }

    /** The value inside, or undefined when the cookie is not ours, was altered, or was made for another purpose. */
    open(purpose: string, cookie: string | undefined): unknown {
        if (!cookie || cookie.length > 4096) return undefined;
        const dot = cookie.indexOf(".");
        if (dot < 1) return undefined;
        const body = cookie.slice(0, dot);
        const given = Buffer.from(cookie.slice(dot + 1), "base64url");
        const expected = this.mac(purpose, body);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
        try {
            return JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as unknown;
        } catch {
            return undefined;
        }
    }

    /** What ties a session to the way it was made: change the token, the password or the allow lists and the
     *  sessions made under the old ones stop working. A MAC, so the cookie does not reveal the material. */
    binding(method: Method, material: string): string {
        return b64url(createHmac("sha256", this.key).update(`binding\0${method}\0${material}`).digest().subarray(0, 16));
    }

    issue(method: Method, subject: string, material: string): string {
        const now = this.now();
        return this.seal("session", { m: method, s: subject, b: this.binding(method, material), iat: now, exp: now + SESSION_TTL_MS });
    }

    /** The session in this cookie if it is ours, unexpired and made under the current configuration of its method.
     *  `renewed` is a fresh cookie value when the session is more than a day old. */
    verify(cookie: string | undefined, materials: Partial<Record<Method, string>>): { session: Session; renewed?: string } | undefined {
        const value = this.open("session", cookie) as Partial<Session> | undefined;
        if (!value || typeof value !== "object") return undefined;
        const { m, s, b, iat, exp } = value;
        if (m !== "token" && m !== "password" && m !== "oidc") return undefined;
        if (typeof s !== "string" || typeof b !== "string" || typeof iat !== "number" || typeof exp !== "number") return undefined;
        const material = materials[m];
        if (material === undefined || b !== this.binding(m, material)) return undefined;
        const now = this.now();
        if (exp <= now || iat > now + 60_000) return undefined;
        const session: Session = { m, s, b, iat, exp };
        return now - iat > SESSION_RENEW_AFTER_MS ? { session, renewed: this.issue(m, s, material) } : { session };
    }

    flow(record: Omit<FlowRecord, "exp">): string {
        return this.seal("oidc-flow", { ...record, exp: this.now() + FLOW_TTL_MS });
    }

    openFlow(cookie: string | undefined): FlowRecord | undefined {
        const v = this.open("oidc-flow", cookie) as Partial<FlowRecord> | undefined;
        if (!v || typeof v !== "object") return undefined;
        const { state, nonce, verifier, next, exp } = v;
        if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return undefined;
        if (typeof next !== "string" || typeof exp !== "number" || exp <= this.now()) return undefined;
        return { state, nonce, verifier, next, exp };
    }
}

/** PIKVM_SESSION_SECRET, or the secret kept in the data directory (made on first use: 32 random bytes, mode 0600, written
 *  whole and renamed into place so a crash never leaves half of one). */
export function loadSessionKey(configured: string, dataDir: string): Buffer {
    if (configured) {
        if (configured.length < 32) throw new Error("PIKVM_SESSION_SECRET must be at least 32 characters");
        return Buffer.from(configured, "utf-8");
    }
    const path = resolve(dataDir, "session-secret");
    try {
        const stored = Buffer.from(readFileSync(path, "utf-8").trim(), "base64url");
        if (stored.length >= 32) return stored;
    } catch {
        /* none yet */
    }
    const fresh = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, b64url(fresh) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return fresh;
}

/** One cookie header value. `maxAge` of 0 clears it. */
export function cookieHeader(
    name: string,
    value: string,
    opts: { secure: boolean; maxAgeSec: number; path?: string },
): string {
    return `${name}=${value}; HttpOnly; Path=${opts.path ?? "/"}; SameSite=Lax; Max-Age=${opts.maxAgeSec}${opts.secure ? "; Secure" : ""}`;
}
