import type { KvmSocket, SocketFactory } from "./ports";

/** `ws(s)://<host>/api/ws`, on the page's own origin so the server's kvmd passthrough carries it. */
export function eventSocketUrl(loc: Pick<Location, "protocol" | "host"> = location): string {
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/ws`;
}

/** The real WebSocket behind the link's socket port. */
export const browserSocket: SocketFactory = (url, handlers) => {
    const ws = new WebSocket(url);
    ws.onopen = () => handlers.open();
    ws.onclose = () => handlers.close();
    ws.onerror = () => handlers.error();
    ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") handlers.message(ev.data);
    };
    const socket: KvmSocket = {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        send: (data) => ws.send(data),
        close: () => ws.close(),
    };
    return socket;
};
