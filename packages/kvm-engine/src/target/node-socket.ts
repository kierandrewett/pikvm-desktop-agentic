import WebSocket from "ws";
import type { KvmSocket, SocketFactory } from "./ports";

/**
 * The link's socket seam for a Node host: a `ws` client that carries kvmd's auth headers.
 *
 * Not exported from the package root. The browser bundle imports `@pikvm/kvm-engine` and must
 * never reach `ws`, so a Node host reaches this through `@pikvm/kvm-engine/node`.
 */
export interface NodeSocketOptions {
    /** Read on every connection attempt, so a rotated password or session cookie is picked up on the retry. */
    readonly headers: () => Readonly<Record<string, string>>;
    /**
     * Verify the Pi's certificate. Off by default: a PiKVM ships a self-signed one, and the
     * proxy and the control core already skip verification for the same reason.
     */
    readonly verifyTls?: boolean;
}

export function nodeSocket(options: NodeSocketOptions): SocketFactory {
    return (url, handlers) => {
        const ws = new WebSocket(url, {
            headers: { ...options.headers() },
            rejectUnauthorized: options.verifyTls === true,
        });
        ws.on("open", () => handlers.open());
        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
            // kvmd's events are JSON text; a binary frame carries nothing the link reads.
            if (!isBinary) handlers.message(rawToString(data));
        });
        ws.on("close", () => handlers.close());
        ws.on("error", () => handlers.error());
        const socket: KvmSocket = {
            isOpen: () => ws.readyState === WebSocket.OPEN,
            send: (data) => ws.send(data),
            close: () => ws.close(),
        };
        return socket;
    };
}

function rawToString(data: WebSocket.RawData): string {
    if (typeof data === "string") return data;
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    return data.toString("utf8");
}
