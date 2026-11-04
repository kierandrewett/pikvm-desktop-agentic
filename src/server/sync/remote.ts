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
