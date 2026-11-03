/**
 * End to end: the real omp binary, the fake model and a fake PiKVM MCP server, through the chat server's WebSocket and
 * REST routes as the PiKVM host mounts them. Nothing here is mocked between the browser's side and the agent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { which } from "../src/agent/launch.ts";
import { CANARY_KEY, startFixture, type Client, type Event, type Fixture } from "./host.ts";

let f: Fixture;

/** Bun is a build tool of the old agent, not of this one: the run proves omp needs none. */
function pathWithoutBun(): string {
    return (process.env.PATH ?? "")
        .split(":")
        .filter((dir) => !existsSync(join(dir, "bun")))
        .join(":");
}

const terminal = (e: Event) => /^response\.(completed|failed|incomplete|cancelled)$/.test(e.type);

/** Send a message and wait for its response to end. Returns the events of that response. */
async function say(
    c: Client,
    input: string | unknown[],
    extra: Record<string, unknown> = {},
): Promise<{ events: Event[]; conversation: string; text: string; end: Event }> {
    const from = c.events.length;
    c.send({ type: "response.create", input, model: "fake/fake-1", ...extra });
    const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
    const events = c.events.slice(from);
    const conversation = (end.response?.conversation?.id ?? extra.conversation) as string;
    const text = events
        .filter((e) => e.type === "response.output_text.delta")
        .map((e) => e.delta as string)
        .join("");
    return { events, conversation, text, end };
}

beforeAll(async () => {
    process.env.PATH = pathWithoutBun();
    f = await startFixture();
});

afterAll(async () => {
    await f.close();
});

describe("without Bun", () => {
    it("has no bun on the PATH the agent gets, and no bun in the one the host has", () => {
        expect(which("bun")).toBeUndefined();
        expect(which("omp")).toBeTruthy();
        expect(f.chat.status().runtime.found).toBe(true);
    });
});

describe("a conversation", () => {
    it("streams a reply, names the chat and keeps it in the list", async () => {
        const c = await f.connect();
        const r = await say(c, "hello there friend");
        expect(r.end.type).toBe("response.completed");
        expect(r.text).toBe("You said: hello there friend");
        expect(c.events[0]?.type).toBe("chat.hello");
        // Deltas arrive before the end, in more than one piece.
        expect(r.events.filter((e) => e.type === "response.output_text.delta").length).toBeGreaterThan(1);
        const list = (await (await f.api("/conversations")).json()) as { conversations: { id: string; title: string }[] };
        expect(list.conversations.map((x) => x.id)).toContain(r.conversation);
        // The title arrives as a conversation update from the chat server's own model call.
        await c.waitFor((e) => e.type === "chat.conversation.updated" && !!e.conversation?.title);
        expect(f.model.titles.length).toBeGreaterThan(0);
        const items = (await (await f.api(`/conversations/${r.conversation}/items`)).json()) as { items: { role?: string }[] };
        expect(items.items.map((i) => i.role)).toEqual(["user", "assistant"]);
        c.close();
    });

    it("offers the agent exactly ask, todo and the PiKVM tools", async () => {
        const c = await f.connect();
        await say(c, "tools?");
        const names = (f.model.requests.at(-1)?.tools ?? []).map((t) => t.function.name).sort();
        expect(names).toEqual(["ask", "mcp__pikvm_click", "mcp__pikvm_key", "mcp__pikvm_screenshot", "todo"]);
        c.close();
    });

    it("calls a tool of the PiKVM server with the conversation it belongs to", async () => {
        const c = await f.connect();
        const before = f.calls.length;
        const r = await say(c, "pikvm:click");
        expect(r.end.type).toBe("response.completed");
        expect(f.calls.slice(before).map((x) => x.tool)).toEqual(["screenshot", "click"]);
        expect(f.calls.at(-1)).toMatchObject({ args: { x: 160, y: 90 }, conversationId: r.conversation });
        expect(r.text).toBe("I clicked the centre of the screen.");
        const calls = r.events.filter((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
        expect(calls.map((e) => e.item.name)).toEqual(["mcp__pikvm_screenshot", "mcp__pikvm_click"]);
        c.close();
    });

    it("asks for approval in the thread, and acts only when it is given", async () => {
        const c = await f.connect();
        const before = f.calls.length;
        const from = c.events.length;
        c.send({ type: "response.create", input: "pikvm:approve", model: "fake/fake-1" });
        const ask = await c.waitFor((e) => e.type === "response.output_item.added" && e.item?.type === "mcp_approval_request");
        expect(ask.item).toMatchObject({
            server_label: "pikvm",
            name: "key",
            reason: "risky",
            title: "Press alt+F4 on the PiKVM?",
        });
        // Nothing has been pressed while the person is deciding.
        expect(f.calls.slice(before).map((x) => x.tool)).toEqual(["screenshot"]);
        const conversation = c.events.find((e) => e.type === "response.created")?.response?.conversation?.id as string;
        c.send({
            type: "response.create",
            conversation,
            input: [{ type: "mcp_approval_response", approval_request_id: ask.item.id, approve: true }],
        });
        const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
        expect(end.type).toBe("response.completed");
        expect(f.calls.slice(before).map((x) => x.tool)).toEqual(["screenshot", "key"]);
        c.close();
    });

    it("sends nothing when the approval is denied", async () => {
        const c = await f.connect();
        const before = f.calls.length;
        const from = c.events.length;
        c.send({ type: "response.create", input: "pikvm:approve", model: "fake/fake-1" });
        const ask = await c.waitFor(
            (e) => e.type === "response.output_item.added" && e.item?.type === "mcp_approval_request" && c.events.indexOf(e) >= from,
        );
        const conversation = c.events.find((e) => e.type === "response.created" && c.events.indexOf(e) >= from)?.response
            ?.conversation?.id as string;
        c.send({
            type: "response.create",
            conversation,
            input: [{ type: "mcp_approval_response", approval_request_id: ask.item.id, approve: false }],
        });
        await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
        expect(f.calls.slice(before).map((x) => x.tool)).toEqual(["screenshot"]);
        c.close();
    });

    it("refuses to ask when nobody is in the thread, and stopping a run closes an open approval", async () => {
        const c = await f.connect();
        const from = c.events.length;
        c.send({ type: "response.create", input: "pikvm:approve", model: "fake/fake-1" });
        await c.waitFor((e) => e.type === "response.output_item.added" && e.item?.type === "mcp_approval_request" && c.events.indexOf(e) >= from);
        const conversation = c.events.find((e) => e.type === "response.created" && c.events.indexOf(e) >= from)?.response
            ?.conversation?.id as string;
        const before = f.calls.length;
        c.send({ type: "response.cancel", conversation });
        const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
        expect(end.type).not.toBe("response.completed");
        expect(f.calls.length).toBe(before);
        // With no running response a built-in server cannot ask: unavailable, never queued.
        const decision = await f.chat.askApproval("pikvm", {
            conversationId: conversation,
            tool: "key",
            title: "t",
            summary: "s",
            reasons: [],
            arguments: {},
        });
        expect(decision).toBe("unavailable");
        c.close();
    });

    it("stops a streaming reply and stays usable", async () => {
        const c = await f.connect();
        const from = c.events.length;
        c.send({ type: "response.create", input: "slow:", model: "fake/fake-1" });
        const created = await c.waitFor((e) => e.type === "response.created" && c.events.indexOf(e) >= from);
        await c.waitFor((e) => e.type === "response.output_text.delta" && c.events.indexOf(e) >= from);
        const conversation = created.response.conversation.id as string;
        c.send({ type: "response.cancel", conversation });
        const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
        expect(end.type).not.toBe("response.completed");
        const again = await say(c, "after the stop", { conversation });
        expect(again.end.type).toBe("response.completed");
        expect(again.text).toBe("You said: after the stop");
        c.close();
    });

    it("resumes from the session file when the agent process has gone", async () => {
        const c = await f.connect();
        const first = await say(c, "remember the word saffron");
        // A new server on the same data directory: the agent process is new, the history is the JSONL file.
        c.close();
        await f.restart();
        const c2 = await f.connect();
        const second = await say(c2, "what was the word", { conversation: first.conversation });
        expect(second.end.type).toBe("response.completed");
        const sent = JSON.stringify(f.model.requests.at(-1)?.messages);
        expect(sent).toContain("remember the word saffron");
        expect(sent).toContain("You said: remember the word saffron");
        c2.close();
    });
});

describe("what the agent can reach", () => {
    it("holds no provider key, PiKVM string or settings in its environment, files or prompts", async () => {
        const c = await f.connect();
        const r = await say(c, "slow:");
        void r;
        // Find the agent process: a child of this one that runs omp.
        const children = readdirSync("/proc")
            .filter((p) => /^\d+$/.test(p))
            .flatMap((p) => {
                try {
                    const stat = readFileSync(`/proc/${p}/stat`, "utf8");
                    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
                    const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
                    return ppid === process.pid && cmd.some((a) => a === "rpc-ui") ? [{ pid: p, cmd }] : [];
                } catch {
                    return [];
                }
            });
        expect(children.length).toBeGreaterThan(0);
        for (const { pid, cmd } of children) {
            const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
            const names = env.map((e) => e.split("=")[0]).sort();
            // Only what launch.ts gives it, and the conversation id.
            expect(names).toEqual(
                ["CHAT_CONVERSATION_ID", "HOME", "LANG", "OMP_SKIP_SETUP", "PATH", "PI_NOTIFICATIONS", "TERM"].sort(),
            );
            expect(env.join("\n")).not.toContain(CANARY_KEY);
            expect(env.find((e) => e.startsWith("PATH="))).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
            // The command line holds no secret either (it is visible to every local user).
            expect(cmd.join(" ")).not.toContain(CANARY_KEY);
        }
        // Generated files: gateway token only.
        const agentDir = join(f.dataDir, "chat", "users", "operator", "home", ".omp", "agent");
        for (const name of ["models.yml", "mcp.json", "config.yml"]) {
            const text = readFileSync(join(agentDir, name), "utf8");
            expect(text, name).not.toContain(CANARY_KEY);
            expect(text, name).not.toMatch(/PIKVM_[A-Z]/);
            expect(text, name).not.toMatch(/password/i);
        }
        expect(readFileSync(join(agentDir, "models.yml"), "utf8")).toContain(`${f.chat.status().agentSurface}/gw/fake`);
        expect(statSync(join(agentDir, "models.yml")).mode & 0o777).toBe(0o600);
        // Prompts and requests the model saw.
        expect(JSON.stringify(f.model.requests)).not.toContain(CANARY_KEY);
        // What the agent presented to the provider is the gateway token, never the key; the gateway added the key.
        for (const a of f.model.auth) expect(a.authorization).toBe(`Bearer ${CANARY_KEY}`);
        // At rest the key is sealed, not plain.
        const db = readFileSync(join(f.dataDir, "chat", "chat.db"));
        expect(db.includes(Buffer.from(CANARY_KEY))).toBe(false);
        // Stop the slow run so the process can idle.
        const conv = (await (await f.api("/conversations")).json()) as { conversations: { id: string }[] };
        c.send({ type: "response.cancel", conversation: conv.conversations[0]!.id });
        c.close();
    });

    it("answers the agent surface only with the gateway token, and nothing else", async () => {
        const base = f.chat.status().agentSurface;
        for (const path of ["/gw/fake/models", "/mcp/pikvm", "/mcp/s/x", "/mcp/conversations", "/app/state", "/", "/api/conversations"]) {
            const res = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
            expect(res.status, path).toBe(401);
        }
        const wrong = await fetch(`${base}/mcp/pikvm`, {
            method: "POST",
            headers: { authorization: "Bearer gw.operator.forged" },
            body: "{}",
        });
        expect(wrong.status).toBe(401);
        // The token the agent holds opens /mcp and /gw only: nothing of the host is served here.
        const token = JSON.parse(
            readFileSync(join(f.dataDir, "chat", "users", "operator", "home", ".omp", "agent", "mcp.json"), "utf8"),
        ).mcpServers.pikvm.headers.Authorization as string;
        for (const path of ["/app/api/v1/state", "/api/conversations", "/healthz", "/mcp/nothing"]) {
            const res = await fetch(`${base}${path}`, { headers: { authorization: token } });
            expect(res.status, path).toBe(404);
        }
    });
});

describe("the REST and socket surface of the host", () => {
    it("refuses a mutation without the request header", async () => {
        const res = await fetch(`${f.origin}/app/chat/api/conversations/x`, { method: "DELETE" });
        expect(res.status).toBe(403);
    });

    it("answers outside its prefix with 404 and bootstraps the operator", async () => {
        expect((await fetch(`${f.origin}/elsewhere`)).status).toBe(404);
        const boot = (await (await f.api("/bootstrap")).json()) as { user: { id: string }; signup: boolean };
        expect(boot.user.id).toBe("operator");
        expect(boot.signup).toBe(false);
    });

    it("answers a malformed event with an error event", async () => {
        const c = await f.connect();
        c.send({ type: "no.such.event" });
        const err = await c.waitFor((e) => e.type === "error");
        expect(err.error.code).toBe("unknown_event");
        c.close();
    });

    it("lists the agent's tools to the composer without calling any of them", async () => {
        const res = (await (await f.api("/mcp?fresh=1")).json()) as {
            servers: { name: string; connected: boolean; tools: { tool: string }[] }[];
        };
        const pikvm = res.servers.find((s) => s.name === "pikvm");
        expect(pikvm?.connected).toBe(true);
        expect(pikvm?.tools.map((t) => t.tool).sort()).toEqual(["click", "key", "screenshot"]);
    });
});
