import { describe, expect, it } from "vitest";
import {
    guardToolNames,
    registerBuiltinMcp,
    type BuiltinMcp,
} from "./builtin.ts";
import { EXTERNAL_MCP, externalMcp, isExternalMcpKey } from "./external.ts";

const LONG =
    "a_very_long_tool_name_that_goes_on_and_on_and_on_until_the_runtime_hashes_it";

function fake(calls: string[]): BuiltinMcp {
    return {
        name: "pikvm",
        tools: ["click"],
        async handle(req) {
            const msg = (await req.json()) as {
                id: number;
                method: string;
                params?: { name?: string };
            };
            if (msg.method === "tools/list") {
                const tools = [{ name: "click" }, { name: LONG }];
                return Response.json({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { tools },
                });
            }
            calls.push(String(msg.params?.name));
            return Response.json({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: "done" }] },
            });
        },
    };
}

const call = (server: BuiltinMcp, body: unknown) =>
    server.handle(
        new Request("http://x/mcp/pikvm", {
            method: "POST",
            body: JSON.stringify(body),
        }),
        {
            userId: "u",
            conversationId: undefined,
        },
    );

describe("a built-in server's tool names", () => {
    it("refuses to run a tool whose runtime name is over 64 characters, and says why", async () => {
        const calls: string[] = [];
        const server = guardToolNames(fake(calls));
        const reply = (await (
            await call(server, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: LONG, arguments: {} },
            })
        ).json()) as {
            result: { isError: boolean; content: { text: string }[] };
        };
        expect(reply.result.isError).toBe(true);
        expect(reply.result.content[0]!.text).toMatch(/^unsupported_tool:/);
        expect(calls).toEqual([]);
        await call(server, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "click", arguments: {} },
        });
        expect(calls).toEqual(["click"]);
    });

    it("does not list such a tool", async () => {
        const server = guardToolNames(fake([]));
        const reply = (await (
            await call(server, { jsonrpc: "2.0", id: 1, method: "tools/list" })
        ).json()) as {
            result: { tools: { name: string }[] };
        };
        expect(reply.result.tools.map((t) => t.name)).toEqual(["click"]);
    });

    it("refuses a batch, which could hide a call from the check, and an unreadable body", async () => {
        const calls: string[] = [];
        const server = guardToolNames(fake(calls));
        const batch = (await (
            await call(server, [
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: LONG },
                },
            ])
        ).json()) as {
            error: { code: number };
        };
        expect(batch.error.code).toBe(-32600);
        const bad = await server.handle(
            new Request("http://x/", { method: "POST", body: "{" }),
            { userId: "u", conversationId: undefined },
        );
        expect(
            ((await bad.json()) as { error: { code: number } }).error.code,
        ).toBe(-32700);
        expect(calls).toEqual([]);
    });

    it("refuses to mount a server that declares one", () => {
        expect(() =>
            registerBuiltinMcp({ ...fake([]), tools: ["click", LONG] }),
        ).toThrow(/unsupported_tool/);
    });
});

describe("external MCP servers", () => {
    it("are none, so a configured list can never reach the agent", () => {
        expect(Object.keys(EXTERNAL_MCP)).toEqual([]);
        expect(externalMcp().value).toEqual({});
    });

    it("recognises every spelling of the settings key", () => {
        for (const key of [
            "agent.mcp",
            "users.operator.agent.mcp",
            "users.operator.agent.mcp.github",
        ]) {
            expect(isExternalMcpKey(key)).toBe(true);
        }
        for (const key of ["agent.mcpApprovals", "agent.providers"])
            expect(isExternalMcpKey(key)).toBe(false);
    });
});
