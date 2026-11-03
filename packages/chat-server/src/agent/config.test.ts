import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { db as orm, schema } from "../db/index.ts";
import { OPERATOR_ID } from "../paths.ts";
import { registerBuiltinMcp } from "../mcp/builtin.ts";
import { setValue } from "../settings/store.ts";
import { gatewayToken } from "./providers.ts";
import { COMPUTER_TOOLS, renderAgentConfig, RUNTIME_TOOLS } from "./config.ts";

const KEY = "sk-unit-secret-1234";
let db: ReturnType<typeof useTempDb>;

beforeAll(() => {
    db = useTempDb();
});
afterAll(() => db.close());

const set = (key: string, value: unknown) =>
    setValue(`users.${OPERATOR_ID}.${key}`, value, OPERATOR_ID);

describe("renderAgentConfig", () => {
    it("serves every provider through the gateway and never writes its key", () => {
        set("agent.providers", {
            acme: {
                enabled: true,
                baseUrl: "https://llm.example/v1",
                api: "openai-completions",
                apiKey: KEY,
                models: [],
            },
        });
        const cfg = renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000");
        const entry = cfg.models.providers.acme as {
            baseUrl: string;
            apiKey: string;
        };
        expect(entry.baseUrl).toBe("http://127.0.0.1:5000/gw/acme");
        expect(entry.apiKey).toBe(gatewayToken(OPERATOR_ID));
        expect(JSON.stringify(cfg)).not.toContain(KEY);
    });

    it("refuses to configure an external MCP server, and ignores one planted in the database", () => {
        const write = () =>
            set("agent.mcp", {
                remote: {
                    enabled: true,
                    type: "http",
                    url: "https://mcp.example/mcp",
                },
            });
        expect(write).toThrow(/Executor gateway/);
        // A row an older build left behind: written around the store, as the database holds it.
        orm.insert(schema.settings)
            .values({
                key: `users.${OPERATOR_ID}.agent.mcp`,
                value: {
                    files: { enabled: true, type: "stdio", command: "npx" },
                    remote: {
                        enabled: true,
                        type: "http",
                        url: "https://mcp.example/mcp",
                    },
                },
                source: "db",
                updatedAt: 0,
                updatedBy: null,
            } as never)
            .run();
        const servers = renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000")
            .mcp.mcpServers;
        expect(Object.keys(servers)).toEqual([]);
    });

    it("denies every built-in tool outside the computer profile and turns the xd:// devices off", () => {
        const { config } = renderAgentConfig(
            OPERATOR_ID,
            "http://127.0.0.1:5000",
        );
        const tools = config.tools as {
            xdev: boolean;
            approval: Record<string, string>;
        };
        expect(tools.xdev).toBe(false);
        for (const tool of RUNTIME_TOOLS) {
            if ((COMPUTER_TOOLS as readonly string[]).includes(tool))
                expect(tools.approval[tool]).toBeUndefined();
            else expect(tools.approval[tool], tool).toBe("deny");
        }
        expect(config.mcp).toEqual({ enableProjectConfig: false });
        expect(config.memory).toEqual({ backend: "off" });
    });

    it("lets a built-in server's tools through the runtime gate, because the server asks for itself", () => {
        const off = registerBuiltinMcp({
            name: "desk",
            tools: ["click"],
            handle: async () => new Response(),
        });
        const cfg = renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000");
        expect(
            (cfg.config.tools as { approval: Record<string, string> }).approval
                .mcp__desk_click,
        ).toBe("allow");
        expect((cfg.mcp.mcpServers.desk as { url: string }).url).toBe(
            "http://127.0.0.1:5000/mcp/desk",
        );
        off();
        expect(
            renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000").mcp
                .mcpServers.desk,
        ).toBeUndefined();
    });

    it("changes its hash when anything it renders changes, so a running agent restarts", () => {
        const a = renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000").hash;
        set("agent.disabledTools", ["todo"]);
        expect(
            renderAgentConfig(OPERATOR_ID, "http://127.0.0.1:5000").hash,
        ).not.toBe(a);
    });
});
