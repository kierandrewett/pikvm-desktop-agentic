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
 *  3. A call that cannot wait gets no way to continue: no link, or a link whose approval is lost.
 *  4. An allowance outlives what the person meant: used twice, used for other arguments or another client, kept after Stop.
 *  5. A script (the access token, a Basic header) approves for the agent it serves.
 *  6. A question nobody answers stays on the screen for ever, or a client piles up questions without limit.
 *
 * The real queue, routes and MCP handler run together. Time is the queue's `after` seam: nothing waits on a clock.
 */

const HOLD = 1_000;
const TTL = 60_000;
const LINK = (id: string) => `https://kvm.example/app/kvm?approve=${id}`;

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
        /** Fire the timers that wait `ms` and are still wanted. */
        fire: (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).forEach((t) => ((t.cancelled = true), t.fn())),
    };
}

function rig(over: Partial<ApprovalQueueOptions> = {}) {
    const time = manualTime();
    const queue = createApprovalQueue({ after: time.after, holdMs: HOLD, ttlMs: TTL, link: LINK, ...over });
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

test("a call that cannot wait ends with the link, the question stays, and the allowed call goes through once when repeated", async () => {
    const { queue, time } = rig();
    const first = queue.ask(request());
    const id = queue.pending()[0]!.id;
    time.fire(HOLD);
    const message = await refusal(first);
    assert.match(message, new RegExp(LINK(id).replaceAll("?", "\\?")));
    assert.match(message, /same arguments, within 5 minutes/);
    assert.equal(queue.pending().length, 1, "the question outlives the call");

    assert.equal(queue.answer(id, "approved"), true);
    assert.deepEqual(queue.pending(), []);
    assert.equal(await queue.ask(request()), "approved", "the repeat goes through");
    const again = queue.ask(request());
    assert.equal(queue.pending().length, 1, "and only once: the next one asks again");
    queue.answer(queue.pending()[0]!.id, "denied");
    assert.equal(await again, "denied");
});

test("an allowance is for that client, that tool and those arguments, ends with its time, and is gone after Stop", async () => {
    let at = 0;
    const { queue, time } = rig({ now: () => at, grantMs: 300_000 });
    const allow = async (over: Partial<ApprovalRequest> = {}) => {
        const asking = queue.ask(request(over));
        time.fire(HOLD);
        await refusal(asking);
        queue.answer(queue.pending().at(-1)!.id, "approved");
    };

    await allow();
    const other = queue.ask(request({ arguments: { text: "something else" } }));
    assert.equal(queue.pending().length, 1, "other arguments ask again");
    queue.clear();
    await other;
    const stranger = queue.ask(request({ conversationId: `${EXTERNAL_PREFIX}Codex` }));
    assert.equal(queue.pending().length, 1, "another client asks again");
    queue.clear();
    await stranger;

    await allow();
    queue.clear();
    const afterStop = queue.ask(request());
    assert.equal(queue.pending().length, 1, "Stop forgets what was allowed");
    queue.clear();
    await afterStop;

    await allow();
    at += 300_001;
    const late = queue.ask(request());
    assert.equal(queue.pending().length, 1, "an allowance that ran out asks again");
    queue.clear();
    await late;
});

test("argument order does not make a different call", async () => {
    const { queue, time } = rig();
    const asking = queue.ask(request({ arguments: { a: 1, b: { c: 2, d: [3, 4] } } }));
    time.fire(HOLD);
    await refusal(asking);
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.equal(await queue.ask(request({ arguments: { b: { d: [3, 4], c: 2 }, a: 1 } })), "approved");
});

test("the same call repeated while it waits joins one card; an answer reaches every call held on it", async () => {
    const { queue } = rig();
    const one = queue.ask(request());
    const two = queue.ask(request());
    assert.equal(queue.pending().length, 1);
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.deepEqual(await Promise.all([one, two]), ["approved", "approved"]);
});

test("a question nobody answers is dropped after its time, and an answer to it finds nothing", async () => {
    const { queue, time } = rig();
    const asking = queue.ask(request());
    const id = queue.pending()[0]!.id;
    assert.equal(queue.pending()[0]?.expiresAt, queue.pending()[0]!.at + TTL);
    time.fire(TTL);
    assert.equal(await asking, "unavailable");
    assert.deepEqual(queue.pending(), []);
    assert.equal(queue.answer(id, "approved"), false);
    assert.equal(time.timers.filter((t) => t.ms === HOLD).every((t) => t.cancelled), true, "the call's own wait is cancelled with it");
});

test("a client that goes away leaves its question waiting for the link; one that already went never asks", async () => {
    const { queue } = rig();
    const gone = new AbortController();
    const abandoned = queue.ask(request({ signal: gone.signal }));
    gone.abort();
    assert.equal(await abandoned, "unavailable");
    assert.equal(queue.pending().length, 1, "the person can still allow it");
    queue.answer(queue.pending()[0]!.id, "approved");
    assert.equal(await queue.ask(request()), "approved", "and the client's next try goes through");

    const already = new AbortController();
    already.abort();
    assert.equal(await queue.ask(request({ signal: already.signal, arguments: { text: "never" } })), "unavailable");
    assert.deepEqual(queue.pending(), []);
});

test("Stop drops every waiting question and its calls, and a client cannot pile up questions without limit", async () => {
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

test("the link path through the real handler: refused with the link, allowed in the browser, repeated and typed exactly once", async () => {
    const { queue, time } = rig();
    const desk = createFakeDesk();
    const mcp = createPikvmMcp({ desk, approver: queue });
    const client = createTestClient(inProcessTransport(mcp, { conversationId: `${EXTERNAL_PREFIX}Executor`, signal: new AbortController().signal }));
    const server = await serve(queue, { method: "oidc", subject: "kieran" });
    try {
        const args = { text: "line one\nline two" };
        const first = client.call("type_text", args);
        await waitingCount(queue, 1);
        const id = queue.pending()[0]!.id;
        time.fire(HOLD);
        const refused = await first;
        assert.equal(refused.isError, true);
        assert.match(refused.text, /approval_denied: The person has not answered yet\. Ask them to open https:\/\/kvm\.example\/app\/kvm\?approve=/);
        assert.ok(refused.text.includes(id));
        assert.equal(desk.calls.filter((c) => c.method === "typeText").length, 0);

        assert.equal((await server.answer({ id, decision: "approved" })).status, 200);
        const repeated = await client.call("type_text", args);
        assert.equal(repeated.isError, false);
        assert.equal(desk.calls.filter((c) => c.method === "typeText").length, 1);

        const third = client.call("type_text", args);
        await waitingCount(queue, 1);
        assert.equal(desk.calls.filter((c) => c.method === "typeText").length, 1, "a second repeat is a new question");
        queue.clear();
        assert.equal((await third).isError, true);
    } finally {
        await server.close();
    }
});

test("a host with no public address tells the client to use the KVM tab", async () => {
    const { queue, time } = rig({ link: undefined });
    const asking = queue.ask(request());
    time.fire(HOLD);
    assert.match(await refusal(asking), /allow it on the KVM tab of the PiKVM app/);
});

test("a declined call types nothing and tells the agent not to repeat it", async () => {
    const { queue } = rig();
    const desk = createFakeDesk();
    const mcp = createPikvmMcp({ desk, approver: queue });
    const client = createTestClient(inProcessTransport(mcp, { conversationId: `${EXTERNAL_PREFIX}Codex`, signal: new AbortController().signal }));
    const server = await serve(queue);
    try {
        const declined = client.call("type_text", { text: "line one\nline two" });
        await waitingCount(queue, 1);
        await server.answer({ id: queue.pending()[0]!.id, decision: "denied" });
        const no = await declined;
        assert.equal(no.isError, true);
        assert.match(no.text, /approval_denied: The person declined/);
        assert.equal(desk.calls.filter((c) => c.method === "typeText").length, 0);
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
