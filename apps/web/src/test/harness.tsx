/**
 * Test harness: the real router, real components and the real API client, with only the
 * environment faked (matchMedia, visualViewport, fetch). What a test asserts is therefore
 * what a user would see and what the server would receive.
 */

import { baseRun, createFakeHarness } from "@pikvm/chat-ui/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createAppRouter } from "../app/router";
import { COMPACT_QUERY } from "../app/viewport";

export interface RecordedRequest {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
}

export interface ServerState {
    keyboardLayout: "us" | "uk";
    jiggler: boolean;
    chat: boolean;
    link: "connected" | "connecting" | "offline" | "unknown";
    macros: ReadonlyArray<unknown>;
    /** Status for PATCH /settings; anything but 200 fails the save with `error` in the body. */
    patchStatus: number;
    patchError: string;
    stateStatus: number;
    /** When set, PATCH /settings waits for it, so a test can look at the in-flight state. */
    patchGate: Promise<void> | undefined;
    /** What HEAD /oauth2/userinfo answers: a status and content type, or a network failure. */
    userinfo: { status: number; contentType: string } | "network-error";
    /** The agent behind /app/harness/*; set its `status` to 502/503 for a proxy whose agent is down. */
    harness: ReturnType<typeof createFakeHarness>;
}

export const defaultServer = (): ServerState => ({
    keyboardLayout: "us",
    jiggler: false,
    chat: true,
    link: "connected",
    macros: [],
    patchStatus: 200,
    patchError: "",
    stateStatus: 200,
    patchGate: undefined,
    userinfo: { status: 404, contentType: "text/plain" },
    harness: createFakeHarness({ runs: [baseRun()] }),
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const decodeBody = (body: unknown): unknown => {
    if (body === undefined || body === null) return undefined;
    const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
    return text === "" ? undefined : JSON.parse(text);
};

export function installFakeServer(server: ServerState): RecordedRequest[] {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const proxied = server.harness.handle(input, init);
            if (proxied) return proxied;
            const request = input instanceof Request ? input : undefined;
            const url = new URL(request?.url ?? String(input), "http://localhost");
            const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
            const body = decodeBody(init?.body ?? (request ? await request.text() : undefined));
            requests.push({ method, path: url.pathname, body });

            if (url.pathname === "/oauth2/userinfo") {
                if (server.userinfo === "network-error") throw new TypeError("network");
                return new Response(null, {
                    status: server.userinfo.status,
                    headers: { "content-type": server.userinfo.contentType },
                });
            }
            if (url.pathname === "/app/api/v1/state") {
                if (server.stateStatus !== 200) return json(server.stateStatus, { error: "state is down" });
                return json(200, {
                    settings: { keyboardLayout: server.keyboardLayout, jiggler: server.jiggler },
                    features: { terminal: true, chat: server.chat },
                    jigglerStatus: { enabled: server.jiggler, mode: "local", nativeSwitchOns: 0, lastNudgeAt: 0, nudges: 0, failures: 0 },
                    pikvm: { origin: "https://pikvm.example", link: server.link },
                    version: "9.9.9",
                });
            }
            if (url.pathname === "/app/api/v1/macros") return json(200, { macros: server.macros });
            if (url.pathname === "/app/api/v1/settings" && method === "PATCH") {
                await server.patchGate;
                if (server.patchStatus !== 200) return json(server.patchStatus, { error: server.patchError });
                const patch = body as Partial<Pick<ServerState, "keyboardLayout" | "jiggler">>;
                if (patch.keyboardLayout) server.keyboardLayout = patch.keyboardLayout;
                if (patch.jiggler !== undefined) server.jiggler = patch.jiggler;
                return json(200, { keyboardLayout: server.keyboardLayout, jiggler: server.jiggler });
            }
            return json(404, { error: "not found" });
        }),
    );
    return requests;
}

export interface Env {
    compact?: boolean;
}

export function installMatchMedia({ compact = false }: Env): void {
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: query === COMPACT_QUERY ? compact : false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
            onchange: null,
        })),
    );
}

/** A visualViewport whose height a test can change, with resize events. */
export class FakeViewport extends EventTarget {
    height: number;
    offsetTop = 0;
    constructor(height: number) {
        super();
        this.height = height;
    }
    resize(height: number): void {
        this.height = height;
        this.dispatchEvent(new Event("resize"));
    }
}

export function installViewport(height = 800): FakeViewport {
    const viewport = new FakeViewport(height);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    // Frames as timers: deterministic, and (unlike an immediate callback) they keep the
    // component's "a frame is pending" bookkeeping honest.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    return viewport;
}

export function renderApp(path: string, env: Env = {}) {
    installMatchMedia(env);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const history = createMemoryHistory({ initialEntries: [`/app${path}`] });
    const router = createAppRouter({ history, basepath: "/app" });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>,
    );
    return { ...view, router, history, queryClient };
}
