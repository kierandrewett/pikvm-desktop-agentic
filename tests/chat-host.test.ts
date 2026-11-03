/**
 * What the host adds around the chat server: the agent routes the KVM tab uses, the MCP adapter, and what
 * `features` says while the server starts, runs and fails.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPikvmMcp } from "@pikvm/mcp";
import { createActivity } from "../src/server/agent/activity";
import { createAgentRoutes } from "../src/server/agent/routes";
import { pikvmBuiltin, startChat } from "../src/server/chat";
import type { AgentDesk } from "../src/server/agent/desk";
import { stubChat } from "./support/chat-stub";

async function serveAgent(over: { handBack?: () => number } = {}) {
    const activity = createActivity();
    const calls: string[] = [];
    const routes = createAgentRoutes(
        activity,
        {
            stop: () => void calls.push("stop"),
            handBack: () => {
                calls.push("handback");
                return over.handBack?.() ?? 1;
            },
        },
        50,
    );
    const server: Server = createServer((req, res) => routes.handle(req, res, new URL(req.url ?? "/", "http://x").pathname));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        activity,
        calls,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

/** Read server-sent events until `count` data events arrived. */
async function events(origin: string, count: number, trigger: () => void): Promise<unknown[]> {
    const res = await fetch(`${origin}/app/api/v1/agent/activity`);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body!.getReader();
    const got: unknown[] = [];
    let buffer = "";
    let triggered = false;
    while (got.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith("data: ")) got.push(JSON.parse(block.slice(6)));
        }
        if (!triggered) {
            triggered = true;
            trigger();
        }
    }
    await reader.cancel();
    return got;
}

test("the activity stream gives the current state first, then each change, and nothing for a repeat", async () => {
    const s = await serveAgent();
    try {
        const got = (await events(s.origin, 3, () => {
            s.activity.set({ state: "working", conversationId: "c1", tool: "click", pointer: { fx: 0.5, fy: 0.25 } });
            s.activity.set({ state: "working", conversationId: "c1", tool: "click", pointer: { fx: 0.5, fy: 0.25 } });
            s.activity.set({ state: "released", conversationId: "c1", reason: "operator" });
        })) as { state: string; tool?: string; reason?: string }[];
        assert.deepEqual(
            got.map((e) => e.state),
            ["idle", "working", "released"],
        );
        assert.equal(got[1]?.tool, "click");
        assert.equal(got[2]?.reason, "operator");
    } finally {
        await s.close();
    }
});

test("Stop and Hand back are POSTs that do what they say; a GET does not", async () => {
    const s = await serveAgent({ handBack: () => 2 });
    try {
        const stop = await fetch(`${s.origin}/app/api/v1/agent/stop`, { method: "POST" });
        assert.deepEqual(await stop.json(), { stopped: true });
        const back = await fetch(`${s.origin}/app/api/v1/agent/handback`, { method: "POST" });
        assert.deepEqual(await back.json(), { handedBack: 2 });
        assert.deepEqual(s.calls, ["stop", "handback"]);
        assert.equal((await fetch(`${s.origin}/app/api/v1/agent/stop`)).status, 405);
        assert.equal((await fetch(`${s.origin}/app/api/v1/agent/activity`, { method: "POST" })).status, 405);
        assert.deepEqual(s.calls, ["stop", "handback"]);
    } finally {
        await s.close();
    }
});

const rpc = (id: number | undefined, method: string, params?: unknown) =>
    new Request("http://agent/mcp/pikvm", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

test("the PiKVM MCP adapter answers one message with one reply and a notification with 202", async () => {
    const desk = {} as never;
    const builtin = pikvmBuiltin(createPikvmMcp({ desk, approver: { ask: async () => "unavailable" } }));
    const ctx = { userId: "operator", conversationId: undefined };
    assert.equal(builtin.name, "pikvm");
    assert.ok(builtin.tools.includes("click") && builtin.tools.includes("screenshot"));

    const init = await builtin.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }), ctx);
    assert.equal(init.status, 200);
    assert.equal(((await init.json()) as { id: number }).id, 1);

    const note = await builtin.handle(rpc(undefined, "notifications/initialized"), ctx);
    assert.equal(note.status, 202);

    const bad = await builtin.handle(new Request("http://agent/mcp/pikvm", { method: "POST", body: "{" }), ctx);
    assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);
});

test("features: not chat while the server starts or if it never does, and what is missing when the agent is", async () => {
    const desk = { stop() {}, handBack: () => 0, beginRun() {}, endRun() {} } as unknown as AgentDesk;
    const lines: string[] = [];

    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    const starting = startChat({
        dataDir: "/unused",
        desk,
        log: (l) => lines.push(l),
        create: async (...args) => {
            await gate;
            return stubChat()(...args);
        },
    });
    assert.deepEqual(starting.features(), { chat: false, agent: { found: false, reason: "Chat is starting" } });
    release();
    await starting.ready;
    assert.deepEqual(starting.features(), { chat: true, agent: { found: true } });
    assert.equal(starting.maxEdge(), 1280);

    const failing = startChat({
        dataDir: "/unused",
        desk,
        log: (l) => lines.push(l),
        create: async () => {
            throw new Error("disk full");
        },
    });
    await failing.ready;
    assert.deepEqual(failing.features(), { chat: false, agent: { found: false, reason: "disk full" } });
    assert.ok(lines.some((l) => l.includes("did not start: disk full")));

    const noAgent = startChat({
        dataDir: "/unused",
        desk,
        create: stubChat({
            status: () => ({ ready: true, runtime: { found: false, reason: "OMP_BIN is not set" }, profile: "computer", agentSurface: "" }),
        }),
    });
    await noAgent.ready;
    assert.deepEqual(noAgent.features(), { chat: true, agent: { found: false, reason: "OMP_BIN is not set" } });
});

test("Stop releases the desk and stops the running responses; Hand back is the desk's", async () => {
    const calls: string[] = [];
    const desk = { stop: () => calls.push("desk.stop"), handBack: () => 3, beginRun() {}, endRun() {} } as unknown as AgentDesk;
    const host = startChat({ dataDir: "/unused", desk, create: stubChat({ stopResponses: () => (calls.push("chat.stop"), 1) }) });
    await host.ready;
    host.controls.stop();
    assert.deepEqual(calls, ["desk.stop", "chat.stop"]);
    assert.equal(host.controls.handBack(), 3);
});
