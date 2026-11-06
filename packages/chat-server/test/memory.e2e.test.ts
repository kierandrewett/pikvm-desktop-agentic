/**
 * End to end with the real omp binary: per-user memory (agent.memory.enabled).
 * Failure modes: memory tools offered when it is off; not offered when it is on; the store kept outside the user's own home
 * (shared between users, or in the process-wide omp database); a first chat that recalls nothing after a fact was kept.
 */
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userKey } from "@pikvm/chat-protocol";
import { OPERATOR_ID } from "../src/paths.ts";
import { setValue } from "../src/settings/store.ts";
import { startFixture, type Client, type Event, type Fixture } from "./host.ts";

let f: Fixture;
beforeAll(async () => {
    f = await startFixture();
});
afterAll(async () => f.close());

const done = (e: Event) => /^response\.(completed|failed|incomplete|cancelled)$/.test(e.type);
async function say(c: Client, input: string): Promise<void> {
    const from = c.events.length;
    c.send({ type: "response.create", input, model: "fake/fake-1" });
    await c.waitFor((e) => done(e) && c.events.indexOf(e) >= from, 60_000);
}
async function sayFull(c: Client, input: string): Promise<string> {
    const from = c.events.length;
    c.send({ type: "response.create", input, model: "fake/fake-1" });
    const end = await c.waitFor((e) => done(e) && c.events.indexOf(e) >= from, 60_000);
    return end.response?.conversation?.id as string;
}
const toolNames = () => (f.model.requests.at(-1)?.tools ?? []).map((t) => t.function.name).sort();
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}

describe("memory", () => {
    it("is off by default: the agent has no memory tool", async () => {
        const c = await f.connect();
        await say(c, "hi");
        expect(toolNames().filter((n) => /^(recall|retain|reflect|memory_edit)$/.test(n))).toEqual([]);
        c.close();
    });

    it("when a user turns it on, the agent is offered the memory tools, and the store is under that user's own directory", async () => {
        setValue(userKey(OPERATOR_ID, "agent.memory.enabled"), true, "e2e");
        const c = await f.connect();
        await say(c, "remember that my cat is called Biscuit");
        const names = toolNames();
        expect(names).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "memory_edit"]));
        const all = files(f.dataDir);
        appendFileSync(`${process.env.HOME}/.cache/pk-e2e/memory.log`, `${JSON.stringify({ tools: names, dataDir: f.dataDir, files: all.map((p) => p.slice(f.dataDir.length)).filter((p) => /mnemo|memor|\.db/i.test(p)) })}\n`);
        c.close();
        expect(all.some((p) => p.includes("/chat/users/operator/home/.omp/agent/memories/"))).toBe(true);
    });

    it("retain, recall and memory_edit run without a denial, and a retained fact is recalled in a new chat", async () => {
        const schemas = Object.fromEntries((f.model.requests.at(-1)?.tools ?? []).filter((t) => /^(recall|retain|reflect|memory_edit)$/.test(t.function.name)).map((t) => [t.function.name, t.function.parameters]));
        appendFileSync(`${process.env.HOME}/.cache/pk-e2e/memory.log`, `${JSON.stringify({ schemas })}\n`);
        const results = async (c: Client, conversation: string) => {
            const items = (await (await f.api(`/conversations/${conversation}/items`)).json()) as { items: { type?: string; output?: unknown }[] };
            return items.items.filter((i) => i.type === "function_call_output").map((i) => JSON.stringify(i.output));
        };
        const c = await f.connect();
        const r1 = await sayFull(c, 'call:retain {"i":"keep","items":[{"content":"The user has a cat called Biscuit","scope":"global"}]}');
        const out1 = await results(c, r1);
        appendFileSync(`${process.env.HOME}/.cache/pk-e2e/memory.log`, `${JSON.stringify({ retain: out1 })}\n`);
        expect(out1.join(" ")).not.toMatch(/denied|not allowed|approval/i);
        const r2 = await sayFull(c, 'call:recall {"i":"look up","query":"cat Biscuit"}');
        const out2 = await results(c, r2);
        appendFileSync(`${process.env.HOME}/.cache/pk-e2e/memory.log`, `${JSON.stringify({ recall: out2 })}\n`);
        expect(out2.join(" ")).toMatch(/Biscuit/);
        // Forget the memory the agent itself kept, by the id recall gave, and it is gone from a later recall.
        const id = /Biscuit \(id: ([0-9a-f]+)\) \[coding-agent-retain\]/.exec(out2.join(" "))?.[1];
        expect(id).toBeDefined();
        const r3 = await sayFull(c, `call:memory_edit {"i":"forget","op":"forget","id":"${id}"}`);
        const out3 = await results(c, r3);
        appendFileSync(`${process.env.HOME}/.cache/pk-e2e/memory.log`, `${JSON.stringify({ forget: out3 })}\n`);
        expect(out3.join(" ")).not.toMatch(/denied|not allowed|approval|Validation failed/i);
        const r4 = await sayFull(c, 'call:recall {"i":"look up","query":"cat Biscuit"}');
        expect((await results(c, r4)).join(" ")).not.toContain(id!);
        c.close();
    });

    it("the forget route empties the store", async () => {
        const memories = () => files(f.dataDir).filter((p) => p.includes("/memories/") && /\.db$/.test(p));
        expect(memories().length).toBeGreaterThan(0);
        const res = await f.api("/memory", { method: "DELETE" });
        expect(res.status).toBe(200);
        expect(memories()).toEqual([]);
    });
});
