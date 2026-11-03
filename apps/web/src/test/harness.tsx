/**
 * Test harness: the real router, real components and the real API client, with only the
 * environment faked (matchMedia, visualViewport, fetch). What a test asserts is therefore
 * what a user would see and what the server would receive.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createManualClock } from "@pikvm/kvm-engine";
import { FakeHttp, FakeSocketHub } from "@pikvm/kvm-engine/testing";
import { createAppRouter } from "../app/router";
import { COMPACT_QUERY } from "../app/viewport";
import { createKvmSession, KvmSessionProvider, type KvmSession } from "../kvm/session";

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
    /** Status for PUT /macros; anything but 200 fails the save. */
    macrosPutStatus: number;
    /** Status for PATCH /settings; anything but 200 fails the save with `error` in the body. */
    patchStatus: number;
    patchError: string;
    stateStatus: number;
    /** The PiKVM target: `editable` is what the desktop app's server says, and false for a hosted one. */
    target: { origin: string; username: string; passwordSet: boolean; editable: boolean };
    /** Status and error for PUT /target; anything but 200 fails the save. */
    targetPutStatus: number;
    targetPutError: string;
    /** When set, PATCH /settings waits for it, so a test can look at the in-flight state. */
    patchGate: Promise<void> | undefined;
    /** What HEAD /oauth2/userinfo answers: a status and content type, or a network failure. */
    userinfo: { status: number; contentType: string } | "network-error";
    /** Whether the chat server found its agent program, and why not. */
    agent: { found: boolean; reason?: string };
}

export const defaultServer = (): ServerState => ({
    keyboardLayout: "us",
    jiggler: false,
    chat: true,
    link: "connected",
    macros: [],
    macrosPutStatus: 200,
    patchStatus: 200,
    patchError: "",
    stateStatus: 200,
    target: { origin: "https://pikvm.example/", username: "", passwordSet: false, editable: false },
    targetPutStatus: 200,
    targetPutError: "",
    patchGate: undefined,
    userinfo: { status: 404, contentType: "text/plain" },
    agent: { found: true },
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
                    features: { chat: server.chat, agent: server.agent },
                    jigglerStatus: { enabled: server.jiggler, mode: "local", nativeSwitchOns: 0, lastNudgeAt: 0, nudges: 0, failures: 0 },
                    pikvm: { origin: "https://pikvm.example", link: server.link },
                    version: "9.9.9",
                });
            }
            if (url.pathname === "/app/api/v1/target") {
                if (method === "PUT") {
                    if (server.targetPutStatus !== 200) return json(server.targetPutStatus, { error: server.targetPutError });
                    const put = body as { origin?: string; username?: string; password?: string };
                    if (put.origin !== undefined) server.target.origin = put.origin;
                    if (put.username !== undefined) server.target.username = put.username;
                    if (put.password !== undefined) server.target.passwordSet = put.password !== "";
                }
                return json(200, server.target);
            }
            if (url.pathname === "/app/api/v1/macros") {
                if (method === "PUT") {
                    if (server.macrosPutStatus !== 200) return json(server.macrosPutStatus, { error: "macro store is read-only" });
                    const put = body as { macros?: ReadonlyArray<unknown> } | undefined;
                    server.macros = put?.macros ?? [];
                }
                return json(200, { macros: server.macros });
            }
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
    /** A coarse primary pointer: a phone or tablet, which gets the touch dock. */
    coarse?: boolean;
    /** The KVM session pages that send to the target use; a rig's, so no real socket opens. */
    session?: KvmSession;
}

export function installMatchMedia({ compact = false, coarse = false }: Env): void {
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: query === COMPACT_QUERY ? compact : query === "(pointer: coarse)" ? coarse : false,
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

/**
 * A session over the engine's fake socket and a clock that never moves: the KVM screen is
 * mounted in every app render (it is the first thing the app starts), and a test that is not about
 * it must not open a real socket or run its timers.
 */
export function quietSession(): KvmSession {
    return createKvmSession({
        clock: createManualClock(1_000_000),
        socket: new FakeSocketHub().factory,
        http: new FakeHttp(),
        url: "ws://kvm/api/ws",
        bindLifecycle: false,
    });
}

export function renderApp(path: string, env: Env = {}) {
    installMatchMedia(env);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const history = createMemoryHistory({ initialEntries: [`/app${path}`] });
    const router = createAppRouter({ history, basepath: "/app" });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <KvmSessionProvider session={env.session ?? quietSession()}>
                <RouterProvider router={router} />
            </KvmSessionProvider>
        </QueryClientProvider>,
    );
    return { ...view, router, history, queryClient };
}

/** A page's EventSource a test can push messages into. Opened streams are kept in `sources`. */
export class FakeEventSource {
    static sources: FakeEventSource[] = [];
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
        FakeEventSource.sources.push(this);
    }
    close(): void {
        this.closed = true;
    }
    emit(data: unknown): void {
        this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
    }
    fail(): void {
        this.onerror?.();
    }
}

export function installEventSource(): typeof FakeEventSource {
    FakeEventSource.sources = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    return FakeEventSource;
}
