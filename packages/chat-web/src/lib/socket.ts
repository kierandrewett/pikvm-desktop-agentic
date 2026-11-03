/**
 * One WebSocket to the chat server per tab. Reconnects with backoff, queues sends while offline and
 * re-asks for the live state of watched conversations after a reconnect.
 */
import type { ClientEvent, ServerEvent } from "@pikvm/chat-protocol";
import { socketUrl } from "./config";

type Listener = (e: ServerEvent) => void;
export type SocketStatus = "connecting" | "open" | "closed";

class ChatSocket {
    #ws: WebSocket | undefined;
    #queue: string[] = [];
    #listeners = new Set<Listener>();
    #statusListeners = new Set<(s: SocketStatus) => void>();
    #retry = 0;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #watched = new Set<string>();
    #session = 0;
    status: SocketStatus = "closed";

    connect(): void {
        if (this.#ws && this.#ws.readyState <= WebSocket.OPEN) return;
        const url = socketUrl();
        this.#setStatus("connecting");
        const ws = new WebSocket(url);
        this.#ws = ws;
        ws.onopen = () => {
            if (this.#ws !== ws) return;
            this.#retry = 0;
            this.#setStatus("open");
            for (const id of this.#watched) ws.send(JSON.stringify({ type: "chat.resume", conversation: id }));
            for (const m of this.#queue.splice(0)) ws.send(m);
        };
        ws.onmessage = (m) => {
            if (this.#ws !== ws) return;
            const e = JSON.parse(String(m.data)) as ServerEvent;
            for (const l of this.#listeners) l(e);
        };
        ws.onclose = () => {
            if (this.#ws !== ws) return;
            this.#ws = undefined;
            this.#setStatus("closed");
            clearTimeout(this.#timer);
            const delay = Math.min(15_000, 500 * 2 ** this.#retry++) * (0.75 + Math.random() * 0.5);
            this.#timer = setTimeout(() => this.connect(), delay);
        };
    }

    disconnect(): void {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        const ws = this.#ws;
        this.#ws = undefined;
        if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            ws.close();
        }
        this.#setStatus("closed");
    }

    /** Remove account-specific state without removing the application's event listeners. */
    resetSession(): void {
        this.#session++;
        this.#queue = [];
        this.#watched.clear();
        this.#retry = 0;
        this.disconnect();
    }

    send(e: ClientEvent): void {
        const data = JSON.stringify(e);
        if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(data);
        else {
            this.#queue.push(data);
            this.connect();
        }
    }

    /** Ask for the live state of a conversation now and after every reconnect. */
    watch(conversationId: string): () => void {
        const session = this.#session;
        this.#watched.add(conversationId);
        if (this.#ws?.readyState === WebSocket.OPEN) this.send({ type: "chat.resume", conversation: conversationId });
        return () => {
            if (session === this.#session) this.#watched.delete(conversationId);
        };
    }

    on(l: Listener): () => void {
        this.#listeners.add(l);
        return () => this.#listeners.delete(l);
    }

    onStatus(l: (s: SocketStatus) => void): () => void {
        this.#statusListeners.add(l);
        return () => this.#statusListeners.delete(l);
    }

    #setStatus(s: SocketStatus): void {
        this.status = s;
        for (const l of this.#statusListeners) l(s);
    }
}

export const socket = new ChatSocket();

export function resetSocketSession(): void {
    socket.resetSession();
}
