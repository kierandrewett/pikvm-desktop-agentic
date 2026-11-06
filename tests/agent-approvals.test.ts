import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AGENT_APPROVAL_PATH, AGENT_APPROVALS_PATH, type PendingApproval } from "@pikvm/contracts/api";
import { createPikvmMcp, DeskError, type ApprovalRequest } from "@pikvm/mcp";
import { createFakeDesk, createTestClient, inProcessTransport } from "@pikvm/mcp/testing";
import { createActivity } from "../src/server/agent/activity";
import { createApprovalQueue, EXTERNAL_PREFIX, MAX_WAITING, type ApprovalQueue, type ApprovalQueueOptions } from "../src/server/agent/approvals";
import { createAgentRoutes } from "../src/server/agent/routes";
import type { SignedIn } from "../src/server/web-auth";

/**
 * FAILURE MODES (written before the tests)
 *
 *  1. A client outside the app has no conversation to ask in, so its risky call is refused with nobody to ask.
 *  2. The person answers, and the call does not go on; or it goes on with something they did not allow.
 *  3. An Allow outlives the call it was for: a later call, other arguments or another client runs on it.
 *  4. A script (the access token, a Basic header) approves for the agent it serves.
 *  5. A question nobody is waiting for stays on the screen, or a client piles up questions without limit.
 *  6. Stop leaves a call waiting, or a question on the screen.
 *
 * The real queue, routes and MCP handler run together. Time is the queue's `after` seam: nothing waits on a clock.
 */

const HOLD = 1_000;

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
        conversationId: `${EXTERNAL_PREFIX}Claude Code (MCP)`,
        tool: "type_text",
        title: "Type this on the PiKVM?",
        summary: "Type: a long text",
        reasons: ["the text is longer than 200 characters"],
        arguments: { text: "x".repeat(300) },
        signal: new AbortController().signal,
        ...over,
    };
}

function manualTime() {
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
        timers,
        after: (fn: () => void, ms: number) => {
            const timer = { fn, ms, cancelled: false };
            timers.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
        /** Fire the timers that are still wanted. */
        fire: () => timers.filter((t) => !t.cancelled).forEach((t) => ((t.cancelled = true), t.fn())),
    };
}

function rig(over: Partial<ApprovalQueueOptions> = {}) {
    const time = manualTime();
    const queue = createApprovalQueue({ after: time.after, holdMs: HOLD, ...over });
    return { time, queue };
}

/** Resolves when the queue lists `count` waiting questions. */
function waitingCount(queue: ApprovalQueue, count: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (queue.pending().length === count) return Promise.resolve();
    const off = queue.subscribe((list) => {
        if (list.length !== count) return;
        off();
        resolve();
    });
    return promise;
}

const refusal = async (asking: Promise<unknown>): Promise<string> => {
    try {
        await asking;
    } catch (error) {
        assert.ok(error instanceof DeskError);
        assert.equal(error.code, "approval_denied");
        return error.message;
    }
    assert.fail("the call was not refused");
};

async function serve(queue: ApprovalQueue, signedIn?: SignedIn) {
    const routes = createAgentRoutes(createActivity(), { stop() {}, handBack: () => 0 }, queue, 50);
    const server: Server = createServer((req, res) => routes.handle(req, res, new URL(req.url ?? "/", "http://x").pathname, signedIn));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answer = (body: unknown) => fetch(origin + AGENT_APPROVAL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return {
        origin,
        answer,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

test("a call waits for the person under the client's name, and the answer is what it gets", async () => {
    const { queue } = rig();
    const asking = queue.ask(request());
    const [waiting] = queue.pending();
    assert.equal(waiting?.client, "Claude Code (MCP)");
    assert.equal(waiting?.tool, "type_text");
    assert.equal(queue.answer(waiting!.id, "approved"), true);
    assert.equal(await asking, "approved");
    assert.deepEqual(queue.pending(), []);
    assert.equal(queue.answer(waiting!.id, "approved"), false, "a second answer finds nothing waiting");

    const declined = queue.ask(request());
    queue.answer(queue.pending()[0]!.id, "denied");
    assert.equal(await declined, "denied");
});

test("the questions are listed in the order they asked", async () => {
    const { queue } = rig();
    const calls = ["one", "two", "three"].map((text) => queue.ask(request({ arguments: { text } })));
    assert.deepEqual(queue.pending().map((p) => p.id).length, 3);
    const [first, second, third] = queue.pending();
    queue.answer(first!.id, "approved");
    assert.deepEqual(queue.pending().map((p) => p.id), [second!.id, third!.id]);
    queue.clear();
    await Promise.all(calls);
});

test("a call nobody answers is refused when its time is up, its question goes, and an Allow after that decides nothing", async () => {
    const { queue, time } = rig();
    const asking = queue.ask(request());
    const id = queue.pending()[0]!.id;
    assert.equal(queue.pending()[0]?.expiresAt, queue.pending()[0]!.at + HOLD);
    time.fire();
    assert.match(await refusal(asking), /did not answer in time/);
    assert.deepEqual(queue.pending(), [], "nobody is waiting for the answer, so the question is gone");
    assert.equal(queue.answer(id, "approved"), false, "a late Allow finds nothing");

    const again = queue.ask(request());
    assert.equal(queue.pending().length, 1, "the same call asks again from the start: nothing was remembered");
    assert.notEqual(queue.pending()[0]!.id, id);
    queue.answer(queue.pending()[0]!.id, "denied");
    assert.equal(await again, "denied");
});

test("an Allow is for the call it was shown for: not a later one, other arguments or another client", async () => {
    const { queue } = rig();
    const first = queue.ask(request());
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.equal(await first, "approved");

    const later = queue.ask(request());
    const other = queue.ask(request({ arguments: { text: "something else" } }));
    const stranger = queue.ask(request({ conversationId: `${EXTERNAL_PREFIX}Codex` }));
    assert.equal(queue.pending().length, 3, "each of them asks");
    queue.clear();
    await Promise.all([later, other, stranger]);
});

test("the same call repeated while it waits joins one card, and one answer reaches every call held on it", async () => {
    const { queue } = rig();
    const one = queue.ask(request({ arguments: { a: 1, b: { c: 2, d: [3, 4] } } }));
    const two = queue.ask(request({ arguments: { b: { d: [3, 4], c: 2 }, a: 1 } }));
    assert.equal(queue.pending().length, 1);
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.deepEqual(await Promise.all([one, two]), ["approved", "approved"]);
});

test("a client that goes away takes its question with it, unless another call is still held on it", async () => {
    const { queue } = rig();
    const gone = new AbortController();
    const abandoned = queue.ask(request({ signal: gone.signal }));
    gone.abort();
    assert.equal(await abandoned, "unavailable");
    assert.deepEqual(queue.pending(), [], "nobody is left to answer for");

    const leaving = new AbortController();
    const first = queue.ask(request({ signal: leaving.signal }));
    const second = queue.ask(request());
    leaving.abort();
    assert.equal(await first, "unavailable");
    assert.equal(queue.pending().length, 1, "the other call still waits on it");
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.equal(await second, "approved");

    const already = new AbortController();
    already.abort();
    assert.equal(await queue.ask(request({ signal: already.signal, arguments: { text: "never" } })), "unavailable");
    assert.deepEqual(queue.pending(), []);
});

test("Stop drops every question and refuses its calls, and a client cannot pile up questions without limit", async () => {
    const { queue } = rig();
    const held = queue.ask(request());
    queue.clear();
    assert.equal(await held, "unavailable");
    assert.deepEqual(queue.pending(), []);

    for (let i = 0; i < MAX_WAITING; i++) void queue.ask(request({ arguments: { i } }));
    assert.equal(queue.pending().length, MAX_WAITING);
    assert.equal(await queue.ask(request({ arguments: { i: "one too many" } })), "unavailable");
    assert.equal(queue.pending().length, MAX_WAITING);
    queue.clear();
});

test("the host is told when a question starts to wait, and a failure telling it does not stop the question", async () => {
    const told: string[] = [];
    const { queue } = rig({
        onWaiting: (approval) => {
            told.push(approval.tool);
            throw new Error("push service down");
        },
    });
    const asking = queue.ask(request());
    assert.deepEqual(told, ["type_text"]);
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.equal(await asking, "approved");
});

test("a risky call from an outside client waits for the person's answer over HTTP, then goes through", async () => {
    const { queue } = rig();
    const desk = createFakeDesk();
    const mcp = createPikvmMcp({ desk, approver: queue });
    const client = createTestClient(inProcessTransport(mcp, { conversationId: `${EXTERNAL_PREFIX}Claude Code (MCP)`, signal: new AbortController().signal }));
    const server = await serve(queue);
    try {
        const call = client.call("type_text", { text: "x".repeat(300) });
        await waitingCount(queue, 1);
        assert.equal(desk.calls.some((c) => c.method === "typeText"), false, "nothing is typed while the person decides");
        const [waiting] = queue.pending();
        assert.match(waiting!.reasons.join(" "), /longer than 200/);

        const reply = await server.answer({ id: waiting!.id, decision: "approved" });
        assert.equal(reply.status, 200);
        assert.deepEqual(await reply.json(), { answered: true });
        assert.equal((await call).isError, false);
        assert.equal(desk.calls.filter((c) => c.method === "typeText").length, 1);
    } finally {
        await server.close();
    }
});

test("through the real handler: declined or unanswered types nothing, an Allow after the call ended changes nothing, and a repeat asks again", async () => {
    const { queue, time } = rig();
    const desk = createFakeDesk();
    const mcp = createPikvmMcp({ desk, approver: queue });
    const client = createTestClient(inProcessTransport(mcp, { conversationId: `${EXTERNAL_PREFIX}Codex`, signal: new AbortController().signal }));
    const server = await serve(queue, { method: "oidc", subject: "kieran" });
    const typed = () => desk.calls.filter((c) => c.method === "typeText").length;
    try {
        const args = { text: "line one\nline two" };
        const declined = client.call("type_text", args);
        await waitingCount(queue, 1);
        await server.answer({ id: queue.pending()[0]!.id, decision: "denied" });
        const no = await declined;
        assert.equal(no.isError, true);
        assert.match(no.text, /approval_denied: The person declined/);

        const unanswered = client.call("type_text", args);
        await waitingCount(queue, 1);
        const id = queue.pending()[0]!.id;
        time.fire();
        const late = await unanswered;
        assert.equal(late.isError, true);
        assert.match(late.text, /approval_denied: The person did not answer in time/);
        assert.equal((await server.answer({ id, decision: "approved" })).status, 404, "an Allow after the call ended finds nothing");
        assert.equal(typed(), 0);

        const repeat = client.call("type_text", args);
        await waitingCount(queue, 1);
        assert.equal(typed(), 0, "the repeat asks again and waits");
        await server.answer({ id: queue.pending()[0]!.id, decision: "approved" });
        assert.equal((await repeat).isError, false);
        assert.equal(typed(), 1);
    } finally {
        await server.close();
    }
});

test("the stream lists what is waiting, first and after every change", async () => {
    const { queue } = rig();
    const server = await serve(queue);
    try {
        const res = await fetch(server.origin + AGENT_APPROVALS_PATH);
        assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
        const reader = res.body!.getReader();
        const lists: PendingApproval[][] = [];
        let buffer = "";
        const next = async () => {
            while (!buffer.includes("\n\n")) {
                const { value, done } = await reader.read();
                if (done) throw new Error("the stream ended");
                buffer += new TextDecoder().decode(value);
            }
            const end = buffer.indexOf("\n\n");
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith("data: ")) lists.push(JSON.parse(block.slice(6)) as PendingApproval[]);
        };
        await next();
        const asking = queue.ask(request());
        await next();
        queue.answer(queue.pending()[0]!.id, "approved");
        await asking;
        await next();
        await reader.cancel();
        assert.deepEqual(lists.map((l) => l.length), [0, 1, 0]);
        assert.equal(lists[1]?.[0]?.client, "Claude Code (MCP)");
    } finally {
        await server.close();
    }
});

test("only a person at the app answers: an access token or Basic header cannot approve for an agent, a bad body is a 400, an old id a 404", async () => {
    const { queue } = rig();
    const asking = queue.ask(request());
    const id = queue.pending()[0]!.id;
    for (const method of ["bearer", "basic"] as const) {
        const script = await serve(queue, { method, subject: "a script" });
        try {
            assert.equal((await script.answer({ id, decision: "approved" })).status, 403);
        } finally {
            await script.close();
        }
    }
    assert.equal(queue.pending().length, 1, "a script's answer changed nothing");

    const person = await serve(queue, { method: "oidc", subject: "kieran" });
    try {
        assert.equal((await person.answer({ id, decision: "maybe" })).status, 400);
        assert.equal((await person.answer({ id, decision: "approved", extra: true })).status, 400);
        assert.equal((await person.answer({ id: "not-waiting", decision: "approved" })).status, 404);
        assert.equal((await person.answer({ id, decision: "approved" })).status, 200);
        assert.equal(await asking, "approved");
    } finally {
        await person.close();
    }
});
