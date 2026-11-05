/**
 * This app's Node process asking a saved server whether it answers the access token.
 *
 * Every call carries the token, so it refuses anything but https, or http to this machine, on every call (not just
 * when the address was saved). Redirects are refused, so the token is never replayed elsewhere. Every error sentence
 * here is fixed text plus the server's address: no token, no password, no part of a reply.
 */

import { checkServerOrigin, ServerError, type RemoteServer } from "../../server-store";

const TIMEOUT_MS = 15_000;

/** The probe: a signed-in read of the server's own state. Any answer other than 200 is refused. */
const PROBE_PATH = "/app/api/v1/state";

/** Asks the server whether it answers the token. Resolves when it does; throws a ServerError otherwise. */
export async function probeServer(server: RemoteServer): Promise<void> {
    const origin = checkServerOrigin(server.origin);
    let response: Response;
    try {
        response = await fetch(`${origin}${PROBE_PATH}`, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { authorization: `Bearer ${server.token}`, accept: "application/json" },
        });
    } catch {
        throw new ServerError(`Could not reach the server at ${origin}.`);
    }
    // Drain the body so the connection is released; its content is not used.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new ServerError("The server did not accept the access token.");
    if (response.status === 403) throw new ServerError("The server refused the request.");
    if (response.status === 404) throw new ServerError("That address is not a PiKVM Desktop server.");
    if (!response.ok) throw new ServerError(`The server answered with an error (${response.status}).`);
}

/**
 * Does the server at this address offer browser sign-in? Asked before anything is opened, so a server that only has an
 * access token says so at once instead of sending the person to a page that does not exist. A fixed sentence for each
 * way it can go wrong.
 */
export async function discoverBrowserSignIn(origin: string, fetchFn: typeof fetch = fetch): Promise<void> {
    const checked = checkServerOrigin(origin);
    let response: Response;
    try {
        response = await fetchFn(`${checked}/app/auth/info`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    } catch {
        throw new ServerError(`Could not reach the server at ${checked}.`);
    }
    let offered = false;
    if (response.ok) {
        try {
            const body: unknown = await response.json();
            offered = typeof body === "object" && body !== null && "device" in body && body.device === true;
        } catch {
            offered = false;
        }
    } else {
        await response.body?.cancel().catch(() => undefined);
    }
    if (!offered) throw new ServerError("This server does not offer browser sign-in. Use its access token instead.");
}

/** Best effort: tells the server this app is done with its device token, so it stops working there too. Never throws. */
export async function revokeDeviceToken(server: RemoteServer, fetchFn: typeof fetch = fetch): Promise<void> {
    try {
        const origin = checkServerOrigin(server.origin);
        const response = await fetchFn(`${origin}/app/api/v1/devices/self`, {
            method: "DELETE",
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { authorization: `Bearer ${server.token}`, accept: "application/json" },
        });
        await response.body?.cancel().catch(() => undefined);
    } catch {
        /* the server is gone or refused: the token is still forgotten here */
    }
}
