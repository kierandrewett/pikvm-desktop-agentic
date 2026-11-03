/**
 * A fake chat server for component tests: `fetch` answers the REST routes from a table, and `WebSocket` is a fake
 * that records what the client sends and lets a test push server events.
 */
import type { ClientEvent, ServerEvent } from "@pikvm/chat-protocol";
import { vi } from "vitest";

export class FakeSocket {
    static all: FakeSocket[] = [];
    static get current(): FakeSocket | undefined {
        return FakeSocket.all.at(-1);
    }
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = 0;
    sent: ClientEvent[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.all.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            this.onopen?.();
        });
    }
    send(data: string) {
        this.sent.push(JSON.parse(data) as ClientEvent);
    }
    close() {
        this.readyState = 3;
    }
    emit(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) as string });
    }
}

export interface FakeRoutes {
    [path: string]: unknown;
}

/** Install fetch and WebSocket. Unlisted GET routes answer 404 as chat's JSON error. */
export function installFakeServer(routes: FakeRoutes): { requests: string[] } {
    const requests: string[] = [];
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input), "http://localhost");
            const path = url.pathname.replace(/^\/app\/chat\/api/, "") + url.search;
            requests.push(`${init?.method ?? "GET"} ${path}`);
            const hit = routes[path] ?? routes[url.pathname.replace(/^\/app\/chat\/api/, "")];
            const body = hit === undefined ? { error: { code: "not_found", message: "not found" } } : hit;
            return new Response(JSON.stringify(body), {
                status: hit === undefined ? 404 : 200,
                headers: { "content-type": "application/json" },
            });
        }),
    );
    return { requests };
}

export const operator = { id: "operator", email: "", name: "Operator", image: null, role: "admin", banned: false };

export const bootstrap = {
    instanceName: "PiKVM",
    signup: "closed",
    needsSetup: false,
    auth: {},
    user: operator,
};

export type { ServerEvent };
