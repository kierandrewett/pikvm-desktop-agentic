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

export interface FakeServer {
    id: string;
    name: string;
    origin: string;
    tokenSet: boolean;
    active: boolean;
    state: "unchecked" | "ok" | "unreachable";
}

export interface FakePikvm {
    id: string;
    name: string;
    origin: string;
    username: string;
    passwordSet: boolean;
    isDefault: boolean;
    active: boolean;
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
    /** The stored PiKVMs: `editable` is what the desktop app's server says, and false for a hosted one. */
    pikvms: { items: FakePikvm[]; editable: boolean };
    /** The servers (Settings > Connection). This computer is always there; `localActive` says it is the one in use.
     *  `editable` is false on a host that pins its state, which hides the section. `addStatus` / `addError` fail a POST. */
    servers: {
        items: FakeServer[];
        localActive: boolean;
        editable: boolean;
        addStatus: number;
        addError: string;
    };
    /** Status and error for any write to /pikvms; anything but 200 fails it. */
    pikvmWriteStatus: number;
    pikvmWriteError: string;
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
    pikvms: {
        items: [
            {
                id: "main",
                name: "PiKVM",
                origin: "https://pikvm.example",
                username: "",
                passwordSet: false,
                isDefault: true,
                active: true,
            },
        ],
        editable: false,
    },
    servers: { items: [], localActive: true, editable: false, addStatus: 200, addError: "" },
    pikvmWriteStatus: 200,
    pikvmWriteError: "",
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

/** What GET /servers answers: the saved remote servers, and whether This computer is the one in use. */
function serverList(server: ServerState) {
    return { items: server.servers.items, localActive: server.servers.localActive, editable: server.servers.editable };
}

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
            const pikvm = /^\/app\/api\/v1\/pikvms(?:\/([^/]+)(?:\/(default|activate))?)?$/.exec(url.pathname);
            if (pikvm) {
                const [, id, action] = pikvm;
                const { items } = server.pikvms;
                const list = () => json(200, server.pikvms);
                if (method === "GET") return list();
                if (server.pikvmWriteStatus !== 200) return json(server.pikvmWriteStatus, { error: server.pikvmWriteError });
                const entry = items.find((item) => item.id === id);
                if (!id) {
                    const add = body as { name: string; origin: string; username?: string; password?: string };
                    const first = items.length === 0;
                    const created: FakePikvm = {
                        id: `added-${items.length + 1}`,
                        name: add.name,
                        origin: add.origin,
                        username: add.username ?? "",
                        passwordSet: (add.password ?? "") !== "",
                        isDefault: first,
                        active: first,
                    };
                    items.push(created);
                    return json(200, created);
                }
                if (!entry) return json(404, { error: "No such PiKVM.", notFound: true });
                if (action === "activate") {
                    for (const item of items) item.active = item === entry;
                    return list();
                }
                if (action === "default") {
                    for (const item of items) item.isDefault = item === entry;
                    return list();
                }
                if (method === "DELETE") {
                    server.pikvms.items = items.filter((item) => item !== entry);
                    if (entry.active && server.pikvms.items[0]) server.pikvms.items[0].active = true;
                    if (entry.isDefault && server.pikvms.items[0]) server.pikvms.items[0].isDefault = true;
                    return list();
                }
                const put = body as { name?: string; origin?: string; username?: string; password?: string };
                if (put.name !== undefined) entry.name = put.name;
                if (put.origin !== undefined) entry.origin = put.origin;
                if (put.username !== undefined) entry.username = put.username;
                if (put.password !== undefined) entry.passwordSet = put.password !== "";
                return json(200, entry);
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
            if (url.pathname === "/app/api/v1/servers" && method === "GET") return json(200, serverList(server));
            if (url.pathname === "/app/api/v1/servers" && method === "POST") {
                if (server.servers.addStatus !== 200) return json(server.servers.addStatus, { error: server.servers.addError });
                const add = body as { name?: string; origin: string; token: string };
                const entry: FakeServer = {
                    id: `srv-${server.servers.items.length + 1}`,
                    name: add.name ?? new URL(add.origin).host,
                    origin: add.origin,
                    tokenSet: true,
                    active: false,
                    state: "ok",
                };
                server.servers.items.push(entry);
                return json(200, entry);
            }
            if (url.pathname === "/app/api/v1/servers/local/use" && method === "POST") {
                for (const item of server.servers.items) item.active = false;
                server.servers.localActive = true;
                return json(200, serverList(server));
            }
            const serverPath = /^\/app\/api\/v1\/servers\/([^/]+)(\/use)?$/.exec(url.pathname);
            if (serverPath) {
                const found = server.servers.items.find((item) => item.id === serverPath[1]);
                if (!found) return json(404, { error: "no such server" });
                if (serverPath[2] && method === "POST") {
                    for (const item of server.servers.items) item.active = false;
                    found.active = true;
                    found.state = "ok";
                    server.servers.localActive = false;
                    return json(200, serverList(server));
                }
                if (!serverPath[2] && method === "DELETE") {
                    server.servers.items = server.servers.items.filter((item) => item !== found);
                    if (found.active) server.servers.localActive = true;
                    return json(200, serverList(server));
                }
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

/** A page's EventSource a test can push messages into. Opened streams are kept in `sources`; the shared cursor's, which every KVM page opens, in `cursors`. */
export class FakeEventSource {
    static sources: FakeEventSource[] = [];
    static cursors: FakeEventSource[] = [];
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
        (url.endsWith("/cursor") ? FakeEventSource.cursors : FakeEventSource.sources).push(this);
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
    FakeEventSource.cursors = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    return FakeEventSource;
}
