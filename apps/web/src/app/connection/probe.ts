/**
 * The host probe: `GET /app/api/v1/session`, a request the host answers from memory (it only reads the sign-in header). It says
 * whether the HOST answers and how fast, and nothing about the PiKVM.
 *
 * Any answer counts, a 401 too: a host that wants a new sign-in is still there. A 502, 503 or 504 does not: that is a proxy in front of
 * the host saying the host is not answering.
 */

import { API_PREFIX } from "@pikvm/contracts/api";

const PROXY_FAILURES: ReadonlySet<number> = new Set([502, 503, 504]);

export async function probeHost(signal: AbortSignal): Promise<void> {
    // High priority: over HTTP/1.1 the browser keeps six connections to a host and the page holds several streams open, so the
    // probe must not wait behind other requests for a free one.
    const response = await fetch(`${API_PREFIX}/session`, { cache: "no-store", credentials: "same-origin", priority: "high", signal });
    // Not read: only the answer matters.
    void response.body?.cancel();
    if (PROXY_FAILURES.has(response.status)) throw new Error(`The host did not answer (${response.status}).`);
}
