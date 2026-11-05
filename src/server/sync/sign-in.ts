/**
 * Signing in to a saved server with the browser, the way desktop apps do it (RFC 8252 with PKCE, RFC 7636).
 *
 * The server's own sign-in (an OpenID Connect provider, a password, the access token) only makes a browser cookie, and
 * this app talks to a server with a bearer, so the two meet at the server's `/app/auth/device` (src/server/web-auth/
 * devices.ts): this app listens on a free port of this machine, sends the person's browser to the server with that port, a
 * random state and the PKCE challenge, and the server sends the browser back here with a one-time code once the person has
 * signed in and said yes. The code and the verifier are traded for a device token, which is saved like any access token.
 *
 * Nothing here returns the token, and every error is a fixed sentence. The listener answers only the exact callback, only
 * on its own `127.0.0.1:<port>` Host (a page of another site cannot reach it by name), only with the state it chose, and
 * only once; it is closed the moment the attempt ends.
 */

import type { ServerAdd, ServerEntry } from "@pikvm/contracts/api";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkServerOrigin, ServerError, ServerNotFound } from "../../server-store";
import { discoverBrowserSignIn, revokeDeviceToken } from "./remote";

/** How long a person has to finish in the browser. */
export const SIGN_IN_TTL_MS = 5 * 60_000;
/** A finished attempt stays readable this long, for the page that is polling it. */
const KEEP_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

export type SignInStatus =
    | { readonly state: "waiting" }
    | { readonly state: "done"; readonly entry: ServerEntry }
    | { readonly state: "failed"; readonly error: string };

export interface SignInDeps {
    /** Saves the server once its token works (the editor's `add`: it probes the server with the token first). */
    save(input: ServerAdd): Promise<ServerEntry>;
    /** Throws ServerAlreadySaved when there is no room for another server, before anything is opened. */
    ensureRoom(): void;
    /** Forgets a saved server again (the editor's `remove` without its side effects): an attempt that was cancelled while it was being saved. */
    forget(id: string): void;
    /** What this computer is called on the server's consent page. */
    deviceName(): string;
    /** Test seams. */
    fetch?: typeof fetch;
    ttlMs?: number;
    /** Runs `run` after `ms` and returns a function that cancels it. Defaults to a timer that does not keep the process alive. */
    after?(ms: number, run: () => void): () => void;
}

export interface BrowserSignIn {
    /** Starts an attempt and returns the address to open in the person's browser. */
    start(input: { readonly origin: string; readonly name?: string | undefined }): Promise<{ id: string; url: string }>;
    /** Throws ServerNotFound for an id that is not (or no longer) an attempt. */
    status(id: string): SignInStatus;
    /** Ends an attempt that is waiting. Always succeeds. */
    cancel(id: string): void;
    /** Ends every attempt: the app is closing. */
    dispose(): void;
}

interface Attempt {
    id: string;
    origin: string;
    name: string | undefined;
    state: string;
    verifier: string;
    server: Server;
    cancelTimer: () => void;
    status: SignInStatus;
    handling: boolean;
}

const sameSecret = (a: string, b: string): boolean => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

const realAfter = (ms: number, run: () => void): (() => void) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
};

/** The little page the browser lands on. No script, nothing from the server in it. */
function respond(res: ServerResponse, status: number, message: string): void {
    const safe = message.replace(/[&<>"']/g, "");
    res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        connection: "close",
    });
    res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PiKVM Desktop</title>` +
            `<body style="font:16px system-ui,sans-serif;margin:2rem;color-scheme:light dark"><main><h1>PiKVM Desktop</h1><p>${safe}</p></main></body></html>`,
    );
}

export function createBrowserSignIn(deps: SignInDeps): BrowserSignIn {
    const fetchFn = deps.fetch ?? fetch;
    const ttl = deps.ttlMs ?? SIGN_IN_TTL_MS;
    const after = deps.after ?? realAfter;
    const attempts = new Map<string, Attempt>();

    /** Ends an attempt that is still waiting: the listener closes now, and the answer stays readable for a while. */
    function finish(attempt: Attempt, status: SignInStatus): void {
        if (attempt.status.state !== "waiting") return;
        attempt.cancelTimer();
        attempt.status = status;
        // No new connections, and idle ones go now. The request being answered at this moment (the one that ended the attempt) is
        // left to finish its reply: it asked to close after it.
        attempt.server.close();
        attempt.server.closeIdleConnections();
        after(KEEP_MS, () => attempts.delete(attempt.id));
    }

    /** The code and the verifier, traded at the server for a device token. */
    async function exchange(attempt: Attempt, code: string): Promise<string> {
        let response: Response;
        try {
            response = await fetchFn(`${attempt.origin}/app/auth/device/token`, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ code, verifier: attempt.verifier }),
            });
        } catch {
            throw new ServerError(`Could not reach the server at ${attempt.origin}.`);
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new ServerError("The server did not accept the sign-in. Start again.");
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = undefined;
        }
        const token = typeof body === "object" && body !== null && "token" in body ? body.token : undefined;
        if (typeof token !== "string" || !/^pkd_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(token)) throw new ServerError("The server did not accept the sign-in. Start again.");
        return token;
    }

    /** The browser came back. Only the exact callback with this attempt's state is listened to, and only once. */
    async function callback(attempt: Attempt, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (req.method !== "GET" || url.pathname !== "/callback" || req.headers.host !== `127.0.0.1:${port}`) {
            res.writeHead(404, { "cache-control": "no-store", connection: "close" });
            res.end();
            return;
        }
        if (!sameSecret(url.searchParams.get("state") ?? "", attempt.state)) return respond(res, 400, "This sign-in link is not for this app.");
        if (attempt.status.state !== "waiting" || attempt.handling) return respond(res, 409, "This sign-in has already been used.");
        attempt.handling = true;
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.has("error") || code === "" || code.length > 2048) {
            finish(attempt, { state: "failed", error: "You did not allow the sign-in." });
            return respond(res, 200, "You did not allow the sign-in. You can close this tab.");
        }
        let token = "";
        try {
            token = await exchange(attempt, code);
            // Cancelled or replaced while the server was answering: the token is no use to anyone.
            if (attempt.status.state !== "waiting") {
                await revokeDeviceToken({ origin: attempt.origin, token }, fetchFn);
                return respond(res, 200, "That sign-in was cancelled. You can close this tab.");
            }
            const entry = await deps.save({ origin: attempt.origin, token, ...(attempt.name ? { name: attempt.name } : {}) });
            // Cancelled or timed out while the server was being saved: it must not stay saved, and its token must not stay valid.
            if (attempt.status.state !== "waiting") {
                try {
                    deps.forget(entry.id);
                } finally {
                    await revokeDeviceToken({ origin: attempt.origin, token }, fetchFn);
                }
                return respond(res, 200, "That sign-in was cancelled. You can close this tab.");
            }
            finish(attempt, { state: "done", entry });
            respond(res, 200, "Signed in. You can close this tab and go back to PiKVM Desktop.");
        } catch (error) {
            // A token the server made but this app could not keep is no use to anyone: take it back.
            if (token !== "") await revokeDeviceToken({ origin: attempt.origin, token }, fetchFn);
            const message = error instanceof ServerError ? error.message : "The sign-in could not be finished. Start again.";
            finish(attempt, { state: "failed", error: message });
            respond(res, 200, `${message} You can close this tab.`);
        }
    }

    return {
        async start(input) {
            const origin = checkServerOrigin(input.origin);
            deps.ensureRoom();
            await discoverBrowserSignIn(origin, fetchFn);
            // One attempt at a time is the useful case (a person starting over), and a few at most.
            const waiting = [...attempts.values()].filter((a) => a.status.state === "waiting");
            for (const old of waiting.slice(0, Math.max(0, waiting.length - (MAX_ATTEMPTS - 1)))) finish(old, { state: "failed", error: "That sign-in was replaced by a newer one." });

            const state = randomBytes(16).toString("base64url");
            const verifier = randomBytes(32).toString("base64url");
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            const id = randomBytes(8).toString("hex");
            const server = createServer();
            const attempt: Attempt = {
                id,
                origin,
                name: input.name?.trim() || undefined,
                state,
                verifier,
                server,
                cancelTimer: after(ttl, () => finish(attempt, { state: "failed", error: "The sign-in took too long. Start again." })),
                status: { state: "waiting" },
                handling: false,
            };
            const listening = Promise.withResolvers<void>();
            server.once("error", listening.reject);
            server.listen(0, "127.0.0.1", listening.resolve);
            await listening.promise.catch(() => {
                attempt.cancelTimer();
                throw new ServerError("Could not listen for the browser on this computer.");
            });
            server.unref();
            const port = (server.address() as AddressInfo).port;
            server.on("request", (req, res) => void callback(attempt, port, req, res));
            attempts.set(id, attempt);
            const query = new URLSearchParams({ port: String(port), state, challenge, name: deps.deviceName() });
            return { id, url: `${origin}/app/auth/device?${query.toString()}` };
        },

        status(id) {
            const attempt = attempts.get(id);
            if (!attempt) throw new ServerNotFound();
            return attempt.status;
        },

        cancel(id) {
            const attempt = attempts.get(id);
            if (!attempt) return;
            finish(attempt, { state: "failed", error: "The sign-in was cancelled." });
        },

        dispose() {
            for (const attempt of attempts.values()) finish(attempt, { state: "failed", error: "The sign-in was cancelled." });
        },
    };
}
