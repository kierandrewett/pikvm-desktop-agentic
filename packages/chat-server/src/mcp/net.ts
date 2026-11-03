/**
 * Outbound HTTP for the MCP gateway and OAuth, with SSRF protection (docs/spec/mcp-support.md section 3).
 *
 * Every URL the server fetches on a user's behalf passes `guardedFetch`:
 * - only http and https; http only when private networks are allowed or the URL is the trusted origin;
 * - the host must resolve to public addresses only (no loopback, private, link-local, CGNAT, multicast, reserved,
 *   or IPv4-mapped forms of those), unless `system.mcp.allowPrivateNetworks` is on;
 * - redirects are followed by hand, at most MAX_REDIRECTS, and every hop is checked again. Non-GET/HEAD requests
 *   follow only same-origin 307/308 redirects, so token request bodies never go to another origin.
 *
 * `trustedOrigin` is the origin of a server an administrator configured: it may use its own private address, but
 * metadata it points to on another origin is checked like any other URL.
 *
 * Known limit: the address is checked before the request, and fetch resolves the name again (a DNS rebinding window).
 * A deployment that needs a hard guarantee runs the server behind an egress proxy.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setting } from "../settings/store.ts";

const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
    constructor(message: string) {
        super(message);
    }
}

function v4Parts(ip: string): number[] {
    return ip.split(".").map(Number);
}

function blockedV4(ip: string): boolean {
    const [a = 0, b = 0, c = 0] = v4Parts(ip);
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

/** True for an address the gateway must not reach without `system.mcp.allowPrivateNetworks`. */
export function isBlockedAddress(ip: string): boolean {
    const kind = isIP(ip);
    if (kind === 4) return blockedV4(ip);
    if (kind !== 6) return true;
    const lower = ip.toLowerCase();
    const mapped =
        lower.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockedV4(mapped[1]!);
    // URL parsing and DNS return the mapped form in hex ("::ffff:7f00:1"), so the last 32 bits are read as hextets.
    const hex =
        lower.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ??
        lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1]!, 16);
        const lo = parseInt(hex[2]!, 16);
        return blockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return (
        (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
        (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
        (first & 0xff00) === 0xff00 || // multicast
        (first === 0x2001 && parseInt(lower.split(":")[1] || "0", 16) === 0x0db8) // documentation
    );
}

export interface GuardOptions {
    /** Origin an administrator configured; it may be private or plain http. */
    trustedOrigin?: string;
    /** Override `system.mcp.allowPrivateNetworks` (tests of the guard itself pass false). */
    allowPrivate?: boolean;
}

/** Throws BlockedUrlError when the URL may not be fetched. */
export async function assertFetchable(raw: string | URL, opts: GuardOptions = {}): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new BlockedUrlError("Not a valid address");
    }
    if (url.username || url.password) throw new BlockedUrlError("Addresses with a user name or password are refused");
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new BlockedUrlError(`Only http and https addresses are allowed, not ${url.protocol}`);
    const allowPrivate = opts.allowPrivate ?? setting("system.mcp.allowPrivateNetworks");
    if (allowPrivate || (opts.trustedOrigin && url.origin === opts.trustedOrigin)) return url;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addresses.length) throw new BlockedUrlError(`Could not resolve ${host}`);
    if (addresses.some(isBlockedAddress))
        throw new BlockedUrlError(
            `${host} is on a private or reserved network. An administrator can allow private networks for MCP.`,
        );
    // After the address check, so a plain-http private address is reported as private, not as an http problem.
    if (url.protocol !== "https:") throw new BlockedUrlError("Only https addresses are allowed");
    return url;
}

/** fetch() with the guard on the URL and on every redirect hop. */
export async function guardedFetch(
    raw: string | URL,
    init: RequestInit = {},
    opts: GuardOptions = {},
): Promise<Response> {
    let url = await assertFetchable(raw, opts);
    let current: RequestInit = { ...init, redirect: "manual" };
    for (let hop = 0; ; hop++) {
        const res = await fetch(url, current);
        if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new BlockedUrlError("Too many redirects");
        const method = (current.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && res.status !== 307 && res.status !== 308)
            throw new BlockedUrlError("The server redirected a request that cannot be repeated");
        const next = new URL(res.headers.get("location")!, url);
        // Header removal cannot protect OAuth codes, verifiers or secrets carried in a request body.
        if (next.origin !== url.origin && method !== "GET" && method !== "HEAD")
            throw new BlockedUrlError("The server redirected a request to another origin");
        // Credential headers never follow a redirect to another origin.
        if (next.origin !== url.origin && current.headers) {
            const h = new Headers(current.headers);
            h.delete("authorization");
            h.delete("cookie");
            current = { ...current, headers: h };
        }
        url = await assertFetchable(next, opts);
    }
}
