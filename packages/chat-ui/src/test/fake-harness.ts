/**
 * A fake harness behind a fetch stub: enough of the API for the workspace to connect, list
 * runs, open one and answer an approval, recording exactly what was sent. Only the network
 * is faked, so a test asserts what the harness would have received.
 */

import { vi } from "vitest";

export interface RecordedCall {
    readonly method: string;
    /** The path with the API base removed, e.g. "/api/runs/run-1/approvals/apr-1". */
    readonly path: string;
    readonly search: string;
    /** Header names lower-cased. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
}

export type RunFixture = Record<string, unknown> & { run_id: string };

export interface FakeHarness {
    readonly calls: RecordedCall[];
    /** Runs the harness reports. Mutate between steps to change what the next poll sees. */
    runs: RunFixture[];
    /** Answer every request with this status (a proxy whose agent is down) until set back to 200. */
    status: number;
    /** Answer approval POSTs with this status. */
    approvalStatus: number;
    callsTo(method: string, pathPrefix: string): RecordedCall[];
}

export const baseRun = (overrides: Record<string, unknown> = {}): RunFixture => ({
    run_id: "run-1",
    task: "Check the disk",
    status: "completed",
    mode: "assistant",
    origin: "managed",
    caller: { interface: "managed_mcp", label: "chat-workspace" },
    created_at: "2026-11-02T08:00:00Z",
    updated_at: "2026-11-02T08:00:05Z",
    event_count: 0,
    event_cursor: 0,
    operator_guidance: [],
    conversation: [
        { message_id: "u1", role: "user", content: "Check the disk", created_at: "2026-11-02T08:00:00Z", event_cursor: 0 },
        {
            message_id: "a1",
            role: "assistant",
            content: "There is 120 GB free on C:.",
            created_at: "2026-11-02T08:00:05Z",
            event_cursor: 0,
        },
    ],
    events: [],
    events_truncated: false,
    ...overrides,
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const decodeBody = (body: unknown): unknown => {
    if (typeof body !== "string" || body === "") return undefined;
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return body;
    }
};

export interface FakeHarnessOptions {
    base?: string;
    runs?: RunFixture[];
}

/**
 * The harness without the network stub: `handle` answers one request, or returns undefined
 * when the URL is not under the base, so a host's test can route only its harness paths here.
 */
export function createFakeHarness({ base = "/app/harness", runs = [] }: FakeHarnessOptions = {}): FakeHarness & {
    handle(input: string | URL | Request, init?: RequestInit): Promise<Response> | undefined;
} {
    const calls: RecordedCall[] = [];
    const harness: FakeHarness & {
        handle(input: string | URL | Request, init?: RequestInit): Promise<Response> | undefined;
    } = {
        calls,
        runs,
        status: 200,
        approvalStatus: 200,
        callsTo: (method, pathPrefix) =>
            calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix)),
        handle(input, init) {
            const url = new URL(String(input), "http://localhost");
            if (!url.pathname.startsWith(base)) return undefined;
            const method = (init?.method ?? "GET").toUpperCase();
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, name) => {
                headers[name.toLowerCase()] = value;
            });
            const path = url.pathname.slice(base.length);
            calls.push({ method, path, search: url.search, headers, body: decodeBody(init?.body) });
            return Promise.resolve(answer(harness, method, path));
        },
    };
    return harness;
}

function answer(harness: FakeHarness, method: string, path: string): Response | Promise<Response> {
    if (harness.status !== 200) return new Response("harness unavailable", { status: harness.status });
    if (path.endsWith("/stream")) return new Promise<Response>(() => {});

    const approval = /^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
    if (approval && method === "POST") {
        if (harness.approvalStatus !== 200) return json(harness.approvalStatus, { detail: "approval refused" });
        const run = harness.runs.find((candidate) => candidate.run_id === approval[1]);
        return json(200, { ...run, status: "running", pending_approval: null });
    }
    const one = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
        const run = harness.runs.find((candidate) => candidate.run_id === decodeURIComponent(one[1] ?? ""));
        return run ? json(200, run) : json(404, { detail: "no such run" });
    }
    switch (path) {
        case "/api/runs":
            return json(200, harness.runs);
        case "/api/providers":
            return json(200, { "claude-account": { ready: true, kind: "claude_cli" } });
        case "/api/tool-servers":
            return json(200, {});
        case "/api/provider-catalog":
        case "/api/tools":
            return json(200, []);
        case "/api/model-catalog":
            return json(200, { available: false, providers: {}, kinds: {} });
        case "/api/health":
            return json(200, { status: "ok", computer_control: "enabled" });
        case "/api/computer-connection":
            return json(200, { enabled: true, mcp_server_name: "Managed PiKVM MCP", machine_name: "Test machine" });
        default:
            return json(404, { detail: `unexpected ${method} ${path}` });
    }
}

export function installFakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
    const harness = createFakeHarness(options);
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            return (await harness.handle(input, init)) ?? json(404, { detail: "not the harness" });
        }),
    );
    return harness;
}

/** A visualViewport a test can resize, with the events a browser dispatches. */
export class FakeVisualViewport extends EventTarget {
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

export function installVisualViewport(height: number): FakeVisualViewport {
    const viewport = new FakeVisualViewport(height);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    return viewport;
}

/** Make every element report this bottom edge, as the layout viewport's full height. */
export function stubLayoutBottom(bottom: number): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, width: 390, height: bottom, bottom, toJSON: () => ({}) }) as DOMRect,
    );
}
