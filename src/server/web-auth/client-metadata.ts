/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document): a client's `client_id` is an https URL, and the
 * document at that URL names it and lists the redirect URIs it may use. The MCP specification prefers this to dynamic registration.
 *
 * The host fetches a URL a stranger chose, so it is a request-forgery risk (the draft's section on SSRF). What is done about it:
 *  - https only, no credentials in the URL, a path (the draft requires one), no fragment;
 *  - the name is resolved first and refused when any address is loopback, private, link-local or otherwise not public, and the fetch
 *    goes to the address that was checked, with the name as the Host and SNI, so a second answer cannot swap it;
 *  - no redirects, 5 s, at most 16 KiB, JSON only;
 *  - the document's own `client_id` must equal the URL, and a redirect URI must be https, or http to this machine.
 * A document is kept for 5 minutes (10 minutes at most), 200 at a time.
 */

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface ClientMetadata {
    name: string;
    redirectUris: string[];
}

const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5000;
const TTL_MS = 5 * 60_000;
const MAX_CACHED = 200;

/** An address a stranger's URL may not make this host call: anything that is not a public unicast address. */
export function isPublicAddress(address: string): boolean {
    const v = isIP(address);
    if (v === 4) {
        const [a, b] = address.split(".").map(Number) as [number, number];
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || b === 0)) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        return true;
    }
    if (v === 6) {
        const x = address.toLowerCase();
        if (x === "::" || x === "::1") return false;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
        if (mapped) return isPublicAddress(mapped[1]!);
        if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff")) return false;
        return true;
    }
    return false;
}

/** Is this `client_id` one to fetch as a document: an https URL with a path and nothing else in it. */
export function isClientMetadataUrl(id: string): boolean {
    if (id.length > 300) return false;
    let u: URL;
    try {
        u = new URL(id);
    } catch {
        return false;
    }
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hash === "" && u.pathname.length > 1 && u.href === id;
}

const acceptableRedirect = (raw: unknown): raw is string => {
    if (typeof raw !== "string" || raw.length > 300) return false;
    try {
        const u = new URL(raw);
        if (u.hash !== "" || u.username !== "" || u.password !== "") return false;
        return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
    } catch {
        return false;
    }
};

export interface FetchLike {
    (url: URL, address: string): Promise<{ status: number; type: string; body: string }>;
}

/** The slice of `https.request` the fetch uses, so a test can stand in for the network. */
export type RequestFn = typeof httpsRequest;

/**
 * One GET to a checked address. No redirect is followed (a 3xx is just a status that is not 200), it takes at most `TIMEOUT_MS`
 * of silence and at most `MAX_BYTES` of body, and the connection goes to the address given with the name as Host and SNI.
 */
export const makeFetchChecked = (request: RequestFn = httpsRequest): FetchLike => (url, address) =>
    new Promise((done, fail) => {
        const req = request(
            { host: address, port: url.port || 443, path: url.pathname + url.search, method: "GET", servername: url.hostname, headers: { host: url.host, accept: "application/json", "user-agent": "pikvm-desktop" }, timeout: TIMEOUT_MS },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_BYTES) {
                        req.destroy(new Error("The client metadata document is too large."));
                        return;
                    }
                    chunks.push(c);
                });
                res.on("end", () => done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf-8") }));
            },
        );
        req.on("timeout", () => req.destroy(new Error("The client metadata document took too long.")));
        req.on("error", fail);
        req.end();
    });

const fetchChecked = makeFetchChecked();

export interface ClientMetadataOptions {
    now?: () => number;
    /** Test seam: the name lookup. */
    resolve?: (host: string) => Promise<string[]>;
    /** Test seam: the one GET. */
    fetch?: FetchLike;
    /**
     * Host names the operator trusts to resolve to a private address (their own service on a tailnet or a LAN, such as an Executor gateway).
     * Only for those exact names the public-address rule is waived; https, no redirects and the size and time limits stay.
     */
    trustedHosts?: readonly string[];
}

export function createClientMetadata(o: ClientMetadataOptions = {}): (clientId: string) => Promise<ClientMetadata | undefined> {
    const now = o.now ?? Date.now;
    const resolve = o.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
    const get = o.fetch ?? fetchChecked;
    const trusted = new Set((o.trustedHosts ?? []).map((h) => h.toLowerCase()));
    const cache = new Map<string, { at: number; value: ClientMetadata | undefined }>();

    return async (clientId) => {
        if (!isClientMetadataUrl(clientId)) return undefined;
        const hit = cache.get(clientId);
        if (hit && now() - hit.at < TTL_MS) return hit.value;
        const value = await load(clientId);
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
        cache.set(clientId, { at: now(), value });
        return value;
    };

    async function load(clientId: string): Promise<ClientMetadata | undefined> {
        const url = new URL(clientId);
        try {
            const host = url.hostname.replace(/^\[|\]$/g, "");
            const addresses = isIP(host) ? [host] : await resolve(host);
            // Every address the name gives must be public: one private answer is enough to refuse.
            if (addresses.length === 0 || (!trusted.has(host.toLowerCase()) && !addresses.every(isPublicAddress))) return undefined;
            const res = await get(url, addresses[0]!);
            if (res.status !== 200 || !/^application\/(?:[\w.+-]+\+)?json\b/i.test(res.type)) return undefined;
            const doc = JSON.parse(res.body) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
            if (doc.client_id !== clientId) return undefined;
            const uris = doc.redirect_uris;
            if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(acceptableRedirect)) return undefined;
            const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 60) : url.host;
            return { name, redirectUris: uris };
        } catch {
            return undefined;
        }
    }
}
