/**
 * What the host adds around the chat server: the agent routes the KVM tab uses, the MCP adapter, and what
 * `features` says while the server starts, runs and fails.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPikvmMcp } from "@pikvm/mcp";
import { createFakeApprover, createFakeDesk } from "@pikvm/mcp/testing";
import { createActivity } from "../src/server/agent/activity";
import { createAgentRoutes } from "../src/server/agent/routes";
import { createApprovalQueue, type ApprovalQueue } from "../src/server/agent/approvals";
import type { SignedIn } from "../src/server/web-auth";
import { pikvmBuiltin, startChat } from "../src/server/chat";
import type { AgentDesk } from "../src/server/agent/desk";
import { stubChat } from "./support/chat-stub";

async function serveAgent(over: { handBack?: () => number; approvals?: ApprovalQueue; signedIn?: SignedIn } = {}) {
    const approvals = over.approvals ?? createApprovalQueue();
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
        approvals,
        50,
    );
    const server: Server = createServer((req, res) => routes.handle(req, res, new URL(req.url ?? "/", "http://x").pathname, over.signedIn));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        activity,
        approvals,
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
    const ctx = { userId: "operator", conversationId: undefined, saveFrame: () => undefined };
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

test("the adapter gives the MCP the chat server's frame store: a screenshot names the frame kept, a click names it again", async () => {
    const kept: { size: { width: number; height: number }; bytes: number }[] = [];
    const ctx = {
        userId: "operator",
        conversationId: "c1",
        saveFrame(jpeg: Uint8Array, size: { width: number; height: number }) {
            kept.push({ size, bytes: jpeg.length });
            return { id: `frame${String(kept.length).padStart(10, "0")}`, ...size };
        },
    };
    const builtin = pikvmBuiltin(createPikvmMcp({ desk: createFakeDesk(), approver: createFakeApprover("approved") }));
    const call = async (name: string, args: unknown) =>
        (await (await builtin.handle(rpc(1, "tools/call", { name, arguments: args }), ctx)).json()) as {
            result: { content: { type: string }[]; _meta?: Record<string, unknown> };
        };

    const shot = await call("screenshot", {});
    // The key is the chat server's `FRAME_META_KEY`, pinned by packages/chat-protocol's own test.
    assert.deepEqual(shot.result._meta, { "chat/frame": { id: "frame0000000001", width: 1280, height: 720 } });
    assert.ok(shot.result.content.some((b) => b.type === "image"), "the model still gets the image");
    assert.deepEqual(kept.map((k) => k.size), [{ width: 1280, height: 720 }]);

    const click = await call("click", { x: 640, y: 360 });
    assert.deepEqual(click.result._meta, shot.result._meta);
    assert.equal(kept.length, 1, "a click keeps no picture of its own");

    // With no conversation the tool refuses, and nothing is kept.
    const bare = await builtin.handle(rpc(2, "tools/call", { name: "screenshot", arguments: {} }), { ...ctx, conversationId: undefined });
    assert.equal(((await bare.json()) as { result: { isError?: boolean } }).result.isError, true);
    assert.equal(kept.length, 1);
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

/*
 * An outside MCP client has no conversation, so the host gives it a run of its own (src/server/chat/index.ts, `mcp`).
 * FAILURE MODES:
 *   X1. The idle clock runs during a long call, so the run ends under a call that is still working.
 *   X2. A client that went quiet keeps the PiKVM (its run never ends).
 *   X3. A timer of an earlier quiet spell ends the run of a newer call.
 *   X4. One client's run is ended by another's.
 */
test("an outside MCP client's run ends only after it has been quiet, never under a call in flight", async () => {
    const events: string[] = [];
    const fake = createFakeDesk();
    const slow = Promise.withResolvers<void>();
    const desk = {
        ...fake,
        info: async () => {
            await slow.promise;
            return fake.info();
        },
        beginRun: (id: string) => void events.push(`begin ${id}`),
        endRun: (id: string) => void events.push(`end ${id}`),
    } as unknown as AgentDesk;
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const host = startChat({
        dataDir: "/unused",
        desk,
        create: stubChat(),
        after: (fn, ms) => {
            const entry = { fn, ms, cancelled: false };
            timers.push(entry);
            return () => void (entry.cancelled = true);
        },
    });
    await host.ready;
    const call = (client: string) => host.mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screen_info", arguments: {} } }, new AbortController().signal, client);
    const fire = () => timers.filter((t) => !t.cancelled).forEach((t) => ((t.cancelled = true), t.fn()));

    const inFlight = call("a");
    await Promise.resolve();
    assert.deepEqual(events, ["begin mcp-a"]);
    assert.equal(timers.length, 0, "X1: no idle clock while the call is working");
    fire();
    assert.deepEqual(events, ["begin mcp-a"], "X1: nothing ends under the call");

    slow.resolve();
    await inFlight;
    assert.equal(timers.filter((t) => !t.cancelled).length, 1, "the clock starts when the call ends");
    const first = timers.find((t) => !t.cancelled)!;

    await call("b");
    assert.deepEqual(events, ["begin mcp-a", "begin mcp-b"], "X4: a second client has its own run");

    await call("a");
    assert.ok(first.cancelled, "X3: the earlier quiet spell's timer was cancelled by the newer call");
    first.fn();
    assert.deepEqual(events, ["begin mcp-a", "begin mcp-b"], "X3: a stale timer ends nothing");

    fire();
    assert.deepEqual(events.sort(), ["begin mcp-a", "begin mcp-b", "end mcp-a", "end mcp-b"], "X2: quiet clients give the PiKVM back, once each");
    fire();
    assert.equal(events.filter((e) => e.startsWith("end")).length, 2);

    await call("a");
    assert.equal(events.filter((e) => e === "begin mcp-a").length, 2, "a client that comes back starts a new run");
});
