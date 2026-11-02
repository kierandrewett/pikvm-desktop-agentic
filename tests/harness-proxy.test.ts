/**
 * Where the web host's Chat tab gets its agent from, and what it sends there.
 *
 * Two upstreams exist: a harness sidecar of its own (PIKVM_HARNESS_*) and the
 * desktop app's console server (PIKVM_DESKTOP_*). Both are reached through the
 * same proxy, chosen by one function, so the failure modes are listed first:
 * half a configuration, two configurations, an origin that carries more than an
 * origin, a token too short for the harness to accept, a browser that tries to
 * bring its own credential, and an upstream that is not there.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiKvmControl } from "../src/pikvm-control";
import { startControlServer } from "../src/server";
import { createHarnessProxy, resolveHarnessUpstream } from "../src/server/proxy/harness";
import { SettingsStore } from "../src/settings";

const OPERATOR = "operator-capability-0123456789abcdef0123456789abcdef";
const DESKTOP = "desktop-access-token-abc";

/* ---------------------------------------------------------------- resolution */

test("with nothing set there is no agent upstream", () => {
    assert.equal(resolveHarnessUpstream({}), null);
    assert.equal(resolveHarnessUpstream({ PIKVM_HARNESS_URL: "  ", PIKVM_DESKTOP_URL: "" }), null);
});

test("a URL without its token, or a token without its URL, is refused", () => {
    // Half a configuration would mount an unauthenticated route to the operator API.
    assert.throws(() => resolveHarnessUpstream({ PIKVM_HARNESS_URL: "http://agent:47616" }), /PIKVM_HARNESS_URL and PIKVM_HARNESS_TOKEN go together/);
    assert.throws(() => resolveHarnessUpstream({ PIKVM_HARNESS_TOKEN: OPERATOR }), /go together/);
    assert.throws(() => resolveHarnessUpstream({ PIKVM_DESKTOP_URL: "http://desk:25650" }), /PIKVM_DESKTOP_URL and PIKVM_DESKTOP_TOKEN go together/);
    assert.throws(() => resolveHarnessUpstream({ PIKVM_DESKTOP_TOKEN: DESKTOP }), /go together/);
});

test("two upstreams are refused rather than one silently winning", () => {
    assert.throws(
        () =>
            resolveHarnessUpstream({
                PIKVM_HARNESS_URL: "http://agent:47616",
                PIKVM_HARNESS_TOKEN: OPERATOR,
                PIKVM_DESKTOP_URL: "http://desk:25650",
                PIKVM_DESKTOP_TOKEN: DESKTOP,
            }),
        /set only one/,
    );
});

test("an upstream must be a bare http(s) origin", () => {
    for (const bad of [
        "agent:47616",
        "ftp://agent",
        "http://user:pw@agent:47616",
        "http://agent:47616/app",
        "http://agent:47616/?x=1",
        "not a url",
    ]) {
        assert.throws(
            () => resolveHarnessUpstream({ PIKVM_HARNESS_URL: bad, PIKVM_HARNESS_TOKEN: OPERATOR }),
            /PIKVM_HARNESS_URL must be a bare origin/,
            bad,
        );
    }
});

test("the harness refuses short operator tokens, so the host says so before it starts", () => {
    assert.throws(
        () => resolveHarnessUpstream({ PIKVM_HARNESS_URL: "http://agent:47616", PIKVM_HARNESS_TOKEN: "short" }),
        /at least 32 characters/,
    );
});

test("the harness upstream strips the app prefix; the desktop upstream keeps the path whole", () => {
    assert.deepEqual(
        resolveHarnessUpstream({ PIKVM_HARNESS_URL: "http://agent:47616/", PIKVM_HARNESS_TOKEN: ` ${OPERATOR} ` }),
        { kind: "harness", origin: "http://agent:47616", token: OPERATOR, prefix: "/app/harness" },
    );
    assert.deepEqual(resolveHarnessUpstream({ PIKVM_DESKTOP_URL: "http://desk:25650", PIKVM_DESKTOP_TOKEN: DESKTOP }), {
        kind: "desktop",
        origin: "http://desk:25650",
        token: DESKTOP,
        prefix: "",
    });
});

/* --------------------------------------------------------------------- proxy */

interface Upstream {
    origin: string;
    seen: { method: string; url: string; headers: IncomingMessage["headers"] }[];
    close(): Promise<void>;
}

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Upstream> {
    const seen: Upstream["seen"] = [];
    const server = createServer((req, res) => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
        handler(req, res);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

async function front(proxy: { handleHttp(req: IncomingMessage, res: ServerResponse): void | Promise<void> }) {
    const server = createServer((req, res) => void proxy.handleHttp(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

const ok = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
};

test("the operator token is added server-side; whatever the browser sent is discarded", async () => {
    const agent = await upstream(ok);
    const proxy = createHarnessProxy({ kind: "harness", origin: agent.origin, token: OPERATOR, prefix: "/app/harness" });
    const page = await front(proxy);
    try {
        const res = await fetch(`${page.origin}/app/harness/api/runs?limit=5`, {
            headers: {
                authorization: "Bearer desktop-managed",
                cookie: "_oauth2_proxy=a-session-the-agent-has-no-business-with",
                "x-pikvm-workspace": "1",
            },
        });
        assert.equal(res.status, 200);
        const [seen] = agent.seen;
        assert.ok(seen);
        assert.equal(seen.url, "/api/runs?limit=5");
        assert.equal(seen.headers.authorization, `Bearer ${OPERATOR}`);
        assert.equal(seen.headers.cookie, undefined);
    } finally {
        await page.close();
        await agent.close();
    }
});

test("the browser never sees the token, even in an error", async () => {
    const proxy = createHarnessProxy({ kind: "harness", origin: "http://127.0.0.1:1", token: OPERATOR, prefix: "/app/harness" });
    const page = await front(proxy);
    try {
        const res = await fetch(`${page.origin}/app/harness/api/runs`);
        const text = await res.text();
        assert.equal(res.status, 502);
        assert.match(text, /harness_unreachable/);
        assert.ok(!text.includes(OPERATOR));
    } finally {
        await page.close();
    }
});

test("the desktop upstream gets the path whole and the desktop's access token", async () => {
    const desk = await upstream(ok);
    const proxy = createHarnessProxy({ kind: "desktop", origin: desk.origin, token: DESKTOP, prefix: "" });
    const page = await front(proxy);
    try {
        await fetch(`${page.origin}/app/harness/api/runs`, { headers: { "x-pikvm-workspace": "1" } });
        const [seen] = desk.seen;
        assert.ok(seen);
        assert.equal(seen.url, "/app/harness/api/runs");
        assert.equal(seen.headers.authorization, `Bearer ${DESKTOP}`);
    } finally {
        await page.close();
        await desk.close();
    }
});

test("an event stream ends upstream when the browser leaves", async () => {
    // A phone that suspends drops its stream without a word; the agent must not
    // keep a run's event subscription open for every one of them.
    let upstreamClosed: () => void = () => {};
    const closed = new Promise<void>((done) => (upstreamClosed = done));
    const agent = await upstream((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hello\n\n");
        req.on("close", upstreamClosed);
        res.on("close", upstreamClosed);
    });
    const proxy = createHarnessProxy({ kind: "harness", origin: agent.origin, token: OPERATOR, prefix: "/app/harness" });
    const page = await front(proxy);
    try {
        const controller = new AbortController();
        const res = await fetch(`${page.origin}/app/harness/api/runs/r1/stream`, { signal: controller.signal });
        const reader = res.body!.getReader();
        await reader.read();
        controller.abort();
        await Promise.race([
            closed,
            new Promise((_, no) => setTimeout(() => no(new Error("upstream stream stayed open")), 3000)),
        ]);
    } finally {
        await page.close();
        await agent.close();
    }
});

/* -------------------------------------------------------------- availability */

test("the agent counts as present only when its health answers 200", async () => {
    for (const [status, expected] of [
        [200, true],
        [401, false],
        [502, false],
        [503, false],
    ] as const) {
        const agent = await upstream((_req, res) => {
            res.writeHead(status);
            res.end("{}");
        });
        const proxy = createHarnessProxy({ kind: "harness", origin: agent.origin, token: OPERATOR, prefix: "/app/harness" });
        try {
            assert.equal(await proxy.available(), expected, `health ${status}`);
            assert.equal(agent.seen[0]?.url, "/api/health");
        } finally {
            await agent.close();
        }
    }
});

test("an absent agent is not available, and the probe does not hang", async () => {
    const proxy = createHarnessProxy({ kind: "harness", origin: "http://127.0.0.1:1", token: OPERATOR, prefix: "/app/harness" });
    assert.equal(await proxy.available(), false);

    // Accepts the connection and never answers.
    const silent = await upstream(() => {});
    const slow = createHarnessProxy(
        { kind: "harness", origin: silent.origin, token: OPERATOR, prefix: "/app/harness" },
        { probeTimeoutMs: 150 },
    );
    try {
        const started = Date.now();
        assert.equal(await slow.available(), false);
        assert.ok(Date.now() - started < 2000);
    } finally {
        await silent.close();
    }
});

test("the desktop's health is asked at the desktop's own path, with its token and the workspace header", async () => {
    const desk = await upstream(ok);
    const proxy = createHarnessProxy({ kind: "desktop", origin: desk.origin, token: DESKTOP, prefix: "" });
    try {
        assert.equal(await proxy.available(), true);
        const [seen] = desk.seen;
        assert.ok(seen);
        assert.equal(seen.url, "/app/harness/api/health");
        assert.equal(seen.headers.authorization, `Bearer ${DESKTOP}`);
        assert.equal(seen.headers["x-pikvm-workspace"], "1");
    } finally {
        await desk.close();
    }
});

test("a state poll storm asks the agent once, and a later change is noticed", async () => {
    let status = 200;
    const agent = await upstream((_req, res) => {
        res.writeHead(status);
        res.end("{}");
    });
    let now = 1_000;
    const proxy = createHarnessProxy(
        { kind: "harness", origin: agent.origin, token: OPERATOR, prefix: "/app/harness" },
        { probeTtlMs: 2_000, now: () => now },
    );
    try {
        const first = await Promise.all([proxy.available(), proxy.available(), proxy.available()]);
        assert.deepEqual(first, [true, true, true]);
        await proxy.available();
        assert.equal(agent.seen.length, 1);

        status = 503;
        now += 2_001;
        assert.equal(await proxy.available(), false);
        assert.equal(agent.seen.length, 2);
    } finally {
        await agent.close();
    }
});

/* ---------------------------------------------------------- through the server */

async function serverWith(harnessOrigin: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-proxy-"));
    const control = {
        proxyTarget: async () => ({ origin: new URL("https://kvm.example.test"), headers: {}, rejectUnauthorized: false }),
        getHidState: () => undefined,
        setLayout: () => {},
        lastInputAt: () => 0,
        noteObservedMouse: () => {},
    } as unknown as PiKvmControl;
    const server = startControlServer(
        {
            control,
            settings: new SettingsStore(join(dir, "settings.json")),
            daemonToken: "unused",
            ...(harnessOrigin ? { harnessOrigin, harnessToken: OPERATOR } : {}),
        },
        0,
    );
    await new Promise<void>((done) => server.once("listening", done));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => {
                    rmSync(dir, { recursive: true, force: true });
                    done();
                });
            }),
    };
}

const chatFeature = async (origin: string): Promise<boolean> =>
    ((await (await fetch(`${origin}/app/api/v1/state`)).json()) as { features: { chat: boolean } }).features.chat;

test("features.chat follows the agent: false with no upstream, true while it answers, false when it stops", async () => {
    const none = await serverWith(null);
    try {
        assert.equal(await chatFeature(none.origin), false);
    } finally {
        await none.close();
    }

    let healthy = true;
    const agent = await upstream((_req, res) => {
        res.writeHead(healthy ? 200 : 503);
        res.end("{}");
    });
    const host = await serverWith(agent.origin);
    try {
        assert.equal(await chatFeature(host.origin), true);
        healthy = false;
        // The first answer is reused for a moment; wait it out rather than guess.
        await new Promise((done) => setTimeout(done, 2_100));
        assert.equal(await chatFeature(host.origin), false);
    } finally {
        await host.close();
        await agent.close();
    }
});

test("through the server, /app/harness needs the workspace header and carries the operator token", async () => {
    const agent = await upstream(ok);
    const host = await serverWith(agent.origin);
    try {
        const bare = await fetch(`${host.origin}/app/harness/api/runs`);
        assert.equal(bare.status, 403);
        assert.equal(agent.seen.filter((s) => s.url.startsWith("/api/runs")).length, 0);

        const res = await fetch(`${host.origin}/app/harness/api/runs`, { headers: { "x-pikvm-workspace": "1" } });
        assert.equal(res.status, 200);
        const forwarded = agent.seen.find((s) => s.url === "/api/runs");
        assert.equal(forwarded?.headers.authorization, `Bearer ${OPERATOR}`);
    } finally {
        await host.close();
        await agent.close();
    }
});

/* ------------------------------------------------------------ cursor reports */

test("a hosted page's cursor report reaches the agent at its own path, and nothing else of the daemon does", async () => {
    // The desktop has the daemon behind /app/daemon. A hosted host has none, only the agent, so it
    // relays this one report and answers 404 to the rest of the daemon's API.
    const agent = await upstream((_req, res) => {
        res.writeHead(204);
        res.end();
    });
    const host = await serverWith(agent.origin);
    const post = (path: string, headers: Record<string, string> = { "x-pikvm-workspace": "1" }) =>
        fetch(`${host.origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: '{"x":1,"y":2}',
        });
    try {
        assert.equal((await post("/app/daemon/cursor", {})).status, 403, "no workspace header");

        const reported = await post("/app/daemon/cursor");
        assert.equal(reported.status, 204);
        const forwarded = agent.seen.find((s) => s.url === "/api/cursor");
        assert.equal(forwarded?.method, "POST");
        assert.equal(forwarded?.headers.authorization, `Bearer ${OPERATOR}`);

        const before = agent.seen.length;
        assert.equal((await post("/app/daemon/sessions")).status, 404);
        assert.equal((await post("/app/daemon/cursor/extra")).status, 404);
        assert.equal((await fetch(`${host.origin}/app/daemon/cursor`, { headers: { "x-pikvm-workspace": "1" } })).status, 405);
        assert.equal(agent.seen.length, before, "none of those reached the agent");
    } finally {
        await host.close();
        await agent.close();
    }
});

test("a cursor report with the agent down is a 502, not a hang", async () => {
    const host = await serverWith("http://127.0.0.1:1");
    try {
        const res = await fetch(`${host.origin}/app/daemon/cursor`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pikvm-workspace": "1" },
            body: '{"x":1,"y":2}',
        });
        assert.equal(res.status, 502);
    } finally {
        await host.close();
    }
});
