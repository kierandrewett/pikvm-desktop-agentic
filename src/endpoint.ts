/**
 * How a local service is reached: a TCP origin, or a unix domain socket.
 *
 * The daemon and the harness are ours — we spawn them, they answer only to us,
 * and nothing outside this machine has any business reaching them. They were
 * still on fixed loopback ports (47615 and 47616), which buys nothing over a
 * socket and costs the usual things: a port can be taken by an orphan of a
 * previous run or by an unrelated program, and anything on the box can connect
 * to it, whereas a socket is a file with an owner and a mode.
 *
 * One string carries either form so it stays human-readable on disk and in the
 * runtime handoff file, which is read by processes that are not this one:
 *
 *     http://127.0.0.1:47615                       TCP, and still supported
 *     unix:/home/you/.config/PiKVM Desktop/d.sock  a socket path, spaces and all
 *
 * Parsed by prefix rather than through URL, deliberately: the settings
 * directory has a space in it on every platform we ship to, and URL would
 * percent-encode that into a path no filesystem call can open.
 */

export interface TcpEndpoint {
    kind: "tcp";
    /** The original string, unchanged, for logs and error messages. */
    value: string;
    protocol: "http:" | "https:";
    hostname: string;
    port: string;
    /** host:port, for the Host header. */
    host: string;
}

export interface UnixEndpoint {
    kind: "unix";
    value: string;
    /** Absolute path of the socket file. */
    socketPath: string;
}

export type Endpoint = TcpEndpoint | UnixEndpoint;

export const UNIX_SCHEME = "unix:";

/** True for anything this module would read as a socket rather than a host. */
export function isUnixEndpointValue(value: string): boolean {
    return value.trim().startsWith(UNIX_SCHEME);
}

/** Build the endpoint string for a socket path, so callers never hand-splice it. */
export function unixEndpointValue(socketPath: string): string {
    return UNIX_SCHEME + socketPath;
}

/**
 * Parse either form. Throws on a socket endpoint with no path, because an empty
 * socketPath fails later at connect time with a message that names neither the
 * setting nor the value that produced it.
 */
export function parseEndpoint(value: string): Endpoint {
    const raw = value.trim().replace(/\/$/, "");
    if (isUnixEndpointValue(raw)) {
        const socketPath = raw.slice(UNIX_SCHEME.length);
        if (!socketPath) throw new Error(`endpoint "${value}" names no socket path`);
        return { kind: "unix", value: raw, socketPath };
    }
    const url = new URL(raw);
    const protocol = url.protocol === "https:" ? "https:" : "http:";
    const port = url.port || (protocol === "https:" ? "443" : "80");
    return {
        kind: "tcp",
        value: raw,
        protocol,
        hostname: url.hostname,
        port,
        host: url.host,
    };
}

/**
 * The node:http request options for one call to `endpoint`.
 *
 * A socket connection still needs a Host header — uvicorn does not care what it
 * says, but Starlette builds absolute URLs from it, so it has to be something
 * rather than nothing. "localhost" is what the socket effectively is.
 */
export function endpointRequestOptions(
    endpoint: Endpoint,
    path: string,
    method: string | undefined,
    headers: Record<string, unknown>,
): Record<string, unknown> {
    if (endpoint.kind === "unix") {
        return {
            socketPath: endpoint.socketPath,
            method,
            path,
            headers: { ...headers, host: "localhost" },
        };
    }
    return {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path,
        headers: { ...headers, host: endpoint.host },
    };
}

/** Whether this endpoint needs node:https rather than node:http. */
export function endpointIsTls(endpoint: Endpoint): boolean {
    return endpoint.kind === "tcp" && endpoint.protocol === "https:";
}
