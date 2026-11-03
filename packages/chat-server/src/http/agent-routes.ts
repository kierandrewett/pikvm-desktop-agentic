/**
 * Composer helpers:
 *   GET /api/commands                  slash commands (app + agent)
 *   GET /api/mcp[?fresh=1]             MCP servers and their tools (composer @ menu, settings); fresh skips the cache
 */
import { Hono } from "hono";
import { ALLOWED_RUNTIME_COMMANDS } from "../agent/commands.ts";
import { listMcp } from "../agent/mcp-catalog.ts";
import { runtimeInfo } from "../models/service.ts";
import { requireUser, type Env } from "./context.ts";

const APP_COMMANDS = [
    { name: "new", description: "Start a new chat", source: "app" as const },
    { name: "model", description: "Choose a model", source: "app" as const },
    { name: "effort", description: "Change reasoning effort", source: "app" as const },
    { name: "clear", description: "Clear the composer", source: "app" as const },
];

export const agentRoutes = new Hono<Env>()
    .get("/commands", async (c) => {
        const user = requireUser(c);
        let agent: { name: string; description?: string; source: "agent" | "skill" | "mcp"; hint?: string }[] = [];
        try {
            agent = (await runtimeInfo(user.id)).commands
                // Runtime builtins Chat allows (agent/commands.ts); the server refuses the others in a prompt.
                .filter((cmd) => (cmd.source === "builtin" ? ALLOWED_RUNTIME_COMMANDS.has(cmd.name) : true))
                .map((cmd) => ({
                    name: cmd.name,
                    description: cmd.description,
                    source: cmd.source === "skill" ? "skill" : cmd.source === "mcp_prompt" ? "mcp" : "agent",
                    hint: cmd.input?.hint,
                }));
        } catch {
            // The runtime may be unavailable; app commands still work.
        }
        return c.json({ commands: [...APP_COMMANDS, ...agent] });
    })
    .get("/mcp", async (c) => {
        const user = requireUser(c);
        return c.json({ servers: await listMcp(user.id, c.req.query("fresh") === "1") });
    });
