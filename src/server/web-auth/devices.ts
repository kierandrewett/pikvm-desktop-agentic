/**
 * Signed-in desktop apps ("devices"): how a PiKVM Desktop that uses this host as its server signs in with whatever the host
 * offers, OpenID Connect included, instead of being given the access token.
 *
 * A desktop app sends `Authorization: Bearer` on every request, and a browser sign-in only ever makes a cookie, so the
 * two meet in the usual desktop way (RFC 8252, with PKCE, RFC 7636):
 *
 *   1. the app opens this host's `/app/auth/device` in the user's browser, naming a loopback port, a state, a PKCE challenge
 *      and a device name;
 *   2. the user signs in as they would for the web app (any method), and the host shows what is being allowed and asks;
 *   3. on Allow, the browser is sent back to `http://127.0.0.1:<port>/callback` with a one-time code (60 s, single use);
 *   4. the app trades the code and its PKCE verifier at `/app/auth/device/token` for a device token, which is
 *      `pkd_<id>_<secret>`; it is shown once, and only a SHA-256 of the secret is kept here.
 *
 * A device token is a bearer like the access token (the same transport and Origin rules), is listed in Settings, Account
 * and can be revoked there, and stops working when the sign-in method it was made under changes its token, password or
 * OpenID provider and allow lists (the same binding a session cookie has). It never becomes a cookie, and a cookie never
 * becomes one.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Method } from "./session";

export const DEVICE_TOKEN_PREFIX = "pkd_";
/** A code lives this long: long enough for the browser to reach the loopback address, too short to be worth guessing. */
export const CODE_TTL_MS = 60_000;
/** The most devices kept; the least recently used one makes room for a new one. */
export const MAX_DEVICES = 50;
/** The most unredeemed codes held at once. */
export const MAX_PENDING_CODES = 200;
/** `lastUsedAt` is written to disk at most this often per device. */
const TOUCH_EVERY_MS = 60_000;
export const NAME_MAX = 60;
export const DEFAULT_DEVICE_NAME = "Desktop app";

const TOKEN = /^pkd_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** A PKCE S256 challenge is a base64url SHA-256: 43 characters. */
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const STATE = /^[A-Za-z0-9_-]{16,128}$/;

export interface DeviceRecord {
    id: string;
    name: string;
    /** SHA-256 of the secret half of the token, hex. */
    hash: string;
    method: Method;
    subject: string;
    /** The sign-in method's configuration when this was made (Sessions.binding). */
    binding: string;
    createdAt: number;
    lastUsedAt: number;
}

/** What a list shows: never the hash. */
export interface DeviceView {
    id: string;
    name: string;
    method: Method;
    subject: string;
    createdAt: number;
    lastUsedAt: number;
}

const view = (d: DeviceRecord): DeviceView => ({
    id: d.id,
    name: d.name,
    method: d.method,
    subject: d.subject,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
});

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A device name safe to show and to store: no control or format characters, one line, at most NAME_MAX characters. A zero-width
 *  or other format character is invisible, so it just goes; a control character (a newline, a tab) separates words. */
export function cleanDeviceName(raw: string | null | undefined): string {
    const text = (raw ?? "")
        .replace(/\p{Cf}+/gu, "")
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const cut = Array.from(text).slice(0, NAME_MAX).join("").trim();
    return cut === "" ? DEFAULT_DEVICE_NAME : cut;
}

/** The devices, in a file in the data directory (mode 0600, written whole and renamed into place). Without a path they
 *  live in memory only (tests). */
export class DeviceStore {
    private devices: DeviceRecord[] = [];
    private touched = new Map<string, number>();

    constructor(
        private readonly path: string | undefined,
        private readonly now: () => number,
    ) {
        if (path !== undefined) this.load(path);
    }

    private load(path: string): void {
        try {
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as { devices?: unknown };
            if (!Array.isArray(parsed.devices)) return;
            for (const d of parsed.devices as Partial<DeviceRecord>[]) {
                if (
                    typeof d.id === "string" && typeof d.name === "string" && typeof d.hash === "string" && typeof d.subject === "string" &&
                    typeof d.binding === "string" && typeof d.createdAt === "number" && typeof d.lastUsedAt === "number" &&
                    (d.method === "token" || d.method === "password" || d.method === "oidc")
                ) {
                    this.devices.push({ id: d.id, name: d.name, hash: d.hash, method: d.method, subject: d.subject, binding: d.binding, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt });
                }
            }
        } catch (error) {
            // No file yet is normal. A file that exists but cannot be read is kept aside, so the next save cannot overwrite it.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                try {
                    renameSync(path, `${path}.corrupt`);
                } catch {
                    /* nothing more to do: the registry starts empty and fails closed */
                }
            }
        }
    }

    private save(): void {
        if (this.path === undefined) return;
        mkdirSync(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ devices: this.devices }, null, 2) + "\n", { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, this.path);
    }

    /** Makes a device and its token, which is returned once and never kept. */
    issue(name: string, method: Method, subject: string, binding: string): { token: string; device: DeviceView } {
        const id = randomBytes(6).toString("hex");
        const secret = randomBytes(32).toString("base64url");
        const at = this.now();
        const record: DeviceRecord = { id, name: cleanDeviceName(name), hash: sha256(secret).toString("hex"), method, subject, binding, createdAt: at, lastUsedAt: at };
        this.devices.push(record);
        if (this.devices.length > MAX_DEVICES) {
            this.devices.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
            this.devices = this.devices.slice(this.devices.length - MAX_DEVICES);
        }
        this.save();
        return { token: `${DEVICE_TOKEN_PREFIX}${id}_${secret}`, device: view(record) };
    }

    /** The device this token belongs to, if it is one and still valid: the secret matches (constant time) and the method
     *  it was made under is still configured the same way (`bindingOf` gives that method's current binding). */
    verify(token: string, bindingOf: (method: Method) => string | undefined): DeviceRecord | undefined {
        const parts = TOKEN.exec(token);
        if (!parts) return undefined;
        const record = this.devices.find((d) => d.id === parts[1]);
        // Hash even when there is no such device, so a missing id and a wrong secret take the same time.
        const given = sha256(parts[2]!);
        const known = record ? Buffer.from(record.hash, "hex") : Buffer.alloc(32);
        const equal = given.length === known.length && timingSafeEqual(given, known);
        if (!record || !equal) return undefined;
        const binding = bindingOf(record.method);
        if (binding === undefined || binding !== record.binding) return undefined;
        const at = this.now();
        record.lastUsedAt = at;
        if (at - (this.touched.get(record.id) ?? 0) >= TOUCH_EVERY_MS) {
            this.touched.set(record.id, at);
            this.save();
        }
        return record;
    }

    list(): DeviceView[] {
        return this.devices.map(view).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }

    /** True when it existed. */
    revoke(id: string): boolean {
        const before = this.devices.length;
        this.devices = this.devices.filter((d) => d.id !== id);
        this.touched.delete(id);
        if (this.devices.length === before) return false;
        this.save();
        return true;
    }
}

interface PendingCode {
    challenge: string;
    name: string;
    method: Method;
    subject: string;
    exp: number;
}

/** The one-time codes between the consent page and the token request. In memory: a restart ends every sign-in in progress. */
export class AuthCodes {
    private codes = new Map<string, PendingCode>();

    constructor(private readonly now: () => number) {}

    issue(entry: Omit<PendingCode, "exp">): string {
        this.sweep();
        if (this.codes.size >= MAX_PENDING_CODES) {
            const oldest = this.codes.keys().next().value;
            if (oldest !== undefined) this.codes.delete(oldest);
        }
        const code = randomBytes(32).toString("base64url");
        this.codes.set(code, { ...entry, exp: this.now() + CODE_TTL_MS });
        return code;
    }

    /** The grant for this code, if the verifier is the one whose SHA-256 the app named. The code is spent either way: a wrong
     *  verifier ends the attempt (it is the app's own, so a wrong one is somebody else's). */
    redeem(code: string, verifier: string): Omit<PendingCode, "exp" | "challenge"> | undefined {
        const found = this.codes.get(code);
        this.codes.delete(code);
        if (!found || found.exp <= this.now()) return undefined;
        if (verifier.length < 43 || verifier.length > 128) return undefined;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const a = Buffer.from(challenge);
        const b = Buffer.from(found.challenge);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
        return { name: found.name, method: found.method, subject: found.subject };
    }

    private sweep(): void {
        const at = this.now();
        for (const [code, entry] of this.codes) if (entry.exp <= at) this.codes.delete(code);
    }
}

const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));

/** The page that asks whether to let a desktop app in. `grant` is the sealed request (what is being allowed, and for whom),
 *  posted back so nothing on this page can be altered between the question and the answer. */
export function consentPage(opts: { name: string; subject: string; grant: string; error?: string }): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Allow PiKVM Desktop</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8eaed;font:16px/1.5 system-ui,sans-serif}
main{width:min(30rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid #2a2f36;border-radius:12px;background:#12161b}
h1{font-size:1.25rem;margin:0 0 .75rem}
dl{margin:1rem 0;display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}
dt{color:#9aa3ad}dd{margin:0;word-break:break-word}
p{color:#c4cad1;margin:.5rem 0}
form{display:flex;gap:.75rem;margin-top:1.25rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid #3a414a;background:#1a2027;color:inherit;cursor:pointer}
button.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}
button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}
.err{color:#f97583}
@media (prefers-color-scheme:light){body{background:#f4f5f7;color:#16191d}main{background:#fff;border-color:#d5d9de}dt{color:#5b6570}p{color:#3b434c}button{background:#eef0f3;border-color:#c6ccd3}}
</style>
</head>
<body>
<main>
<h1>Allow this app to use this server?</h1>
${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
<dl>
<dt>App</dt><dd>PiKVM Desktop</dd>
<dt>Device</dt><dd>${escapeHtml(opts.name)}</dd>
<dt>Signed in as</dt><dd>${escapeHtml(opts.subject)}</dd>
</dl>
<p>It will be able to do what you can do here, until you remove it in Settings, Account on this server.</p>
<form method="post" action="/app/auth/device">
<input type="hidden" name="grant" value="${escapeHtml(opts.grant)}">
<button class="primary" type="submit" name="decision" value="allow" autofocus>Allow</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form>
</main>
</body>
</html>`;
}

/** The page a refused or malformed request to /app/auth/device gets: nothing to act on, nothing about why beyond this. */
export function devicePageError(message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PiKVM Desktop</title></head><body style="font:16px system-ui,sans-serif;margin:2rem"><main><h1>${escapeHtml(message)}</h1><p>Close this tab and try again from PiKVM Desktop.</p></main></body></html>`;
}
