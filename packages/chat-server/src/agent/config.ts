/**
 * Renders the agent runtime config from effective settings into users/<id>/home/.omp/agent/.
 * These files are derived output: never edit them, change settings or this generator.
 *
 * - models.yml  every provider rewritten to the gateway with a per-user token, so no provider key enters the agent
 * - mcp.json    remote MCP servers through the gateway, plus the built-in servers the host mounted
 * - config.yml  the `computer` tool profile, per-tool MCP policies, implicit local discovery off, model roles,
 *               compaction, background jobs off (subagents run inside the turn)
 *
 * JSON is valid YAML 1.2, so models.yml and config.yml are written as JSON.
 *
 * Tool profiles (`system.agent.profile`). Only `computer` exists: the agent is offered `ask`, `todo` and the MCP
 * tools, and every other built-in tool is denied at the approval gate and switched off at its source. omp mounts MCP
 * servers and many built-ins as devices behind `xd://` URLs reached through `read` and `write`; denying those two
 * would cut MCP too, so `tools.xdev` is false, which exposes MCP tools at the top level instead.
 */
import type { McpServer, Provider } from "@pikvm/chat-protocol";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { connectionEpoch, personalServerAllowed, RESERVED_SERVER_IDS } from "../mcp/credentials.ts";
import { listBuiltinMcp } from "../mcp/builtin.ts";
import { toolsSeen } from "../mcp/tool-cache.ts";
import { paths } from "../paths.ts";
import { resolveSetting, setting } from "../settings/store.ts";
import { mcpToolName } from "./mcp-names.ts";
import { BUILTIN_PROVIDERS, gatewayToken, resolveEndpoint } from "./providers.ts";
import { retryConfig } from "./retry-limits.ts";
import { runtimeOptions, SWITCHED_TOOLS, toolSwitchesOff } from "./runtime-options.ts";

/** Runtime per-request timeout for MCP gateway servers (ms). */
const GATEWAY_TIMEOUT_MS = 15 * 60_000;

/** Local engines the runtime probes implicitly. Off unless configured as a provider. */
const IMPLICIT_LOCAL = ["ollama", "llama.cpp", "lm-studio"];

/**
 * Built-in tool names of the runtime this server was tested with (omp 18.14, src/tools/builtin-names.ts, plus the
 * hidden ones). The binary has no source to read, so a tool a newer runtime adds is not on this list: the `--tools`
 * allowlist and `tools.xdev: false` keep it out, and the tool-list test in the E2E suite fails when one appears.
 */
export const RUNTIME_TOOLS = [
    "read",
    "bash",
    "edit",
    "ast_grep",
    "ast_edit",
    "ask",
    "debug",
    "ida",
    "eval",
    "github",
    "glob",
    "grep",
    "find",
    "lsp",
    "checkpoint",
    "rewind",
    "context_notes",
    "new_context",
    "security_scan",
    "task",
    "wait",
    "todo",
    "web_search",
    "write",
    "memory_edit",
    "retain",
    "recall",
    "reflect",
    "learn",
    "manage_skill",
] as const;

/** The built-in tools the `computer` profile keeps. */
export const COMPUTER_TOOLS = ["ask", "todo"] as const;

/** Runtime flags that keep skills, rules, extensions and context files out of the agent's prompt and tool set. */
export const COMPUTER_ARGS = [
    "--tools",
    COMPUTER_TOOLS.join(","),
    "--no-skills",
    "--no-rules",
    "--no-extensions",
    "--no-context-files",
    "--no-lsp",
    "--no-pty",
] as const;

export interface RenderedConfig {
    models: { providers: Record<string, unknown> };
    mcp: { mcpServers: Record<string, unknown> };
    config: Record<string, unknown>;
    /** Changes whenever any rendered file changes; running agents restart on their next turn. */
    hash: string;
    /** Providers that could not be rendered, with the reason. */
    skipped: { id: string; reason: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function renderAgentConfig(userId: string, gatewayBase: string): RenderedConfig {
    const providersR = resolveSetting("agent.providers", userId);
    const mcpR = resolveSetting("agent.mcp", userId);
    const skipped: RenderedConfig["skipped"] = [];

    // Every provider is served through the gateway. The real key stays in settings; the agent holds a gateway token.
    const providers: Record<string, unknown> = {};
    for (const [id, p] of Object.entries(providersR.value as Record<string, Provider>)) {
        if (!p.enabled) continue;
        const ep = resolveEndpoint(id, p);
        if (!ep) {
            skipped.push({ id, reason: "needs baseUrl and api" });
            continue;
        }
        providers[id] = stripUndefined({
            models: p.models,
            discovery: p.discovery,
            baseUrl: `${gatewayBase}/gw/${id}`,
            // Built-in ids keep the runtime's own API choice and catalogue; custom ids need it spelled out.
            api: BUILTIN_PROVIDERS[id] && !p.api ? undefined : ep.api,
            apiKey: gatewayToken(userId),
            auth: "apiKey",
        });
    }

    const mcpServers: Record<string, unknown> = {};
    // Per-tool MCP policies become runtime approval entries under the runtime's tool name (see mcp-names.ts).
    const toolPolicies: Record<string, "prompt" | "deny" | "allow"> = {};
    const setPolicy = (server: string, tool: string, policy: "prompt" | "deny" | "allow", overwrite = true) => {
        const key = mcpToolName(server, tool);
        // The runtime hashes a name over 64 characters in a way we cannot reproduce. A policy we cannot key must never
        // become a gap, so the server's whole tool set stays gated by the profile's own deny-by-default below.
        if (!key) return;
        if (overwrite || !(key in toolPolicies)) toolPolicies[key] = policy;
    };
    const mcpApprovals = setting("agent.mcpApprovals", userId);
    for (const [name, m] of Object.entries(mcpR.value as Record<string, McpServer>)) {
        if (!m.enabled) continue;
        if (mcpR.owners?.[name] === "user" && !personalServerAllowed(userId, m)) continue;
        // Only the gateway may carry a server's credentials. A server the runtime would start itself (stdio) would run
        // as the operator, with no sandbox to hold it.
        if (m.type !== "http" || !m.url || RESERVED_SERVER_IDS.has(name)) continue;
        mcpServers[name] = {
            type: "http",
            url: `${gatewayBase}/mcp/s/${name}`,
            headers: {
                Authorization: `Bearer ${gatewayToken(userId)}`,
                "X-Chat-Conversation": "${CHAT_CONVERSATION_ID}",
                "X-Chat-Connection": String(connectionEpoch(userId, name)),
            },
            // Per request: long enough for a person to answer a form the server asks for. Stop still cancels.
            timeout: Math.max(m.timeout ?? 0, GATEWAY_TIMEOUT_MS),
        };
        for (const [tool, policy] of Object.entries(m.tools ?? {})) {
            setPolicy(name, tool, policy === "off" ? "deny" : "prompt");
        }
        // Tools the server marks read-only run without asking (agent.mcpApprovals); a per-tool policy wins.
        if (mcpApprovals.trustReadOnly) {
            for (const t of toolsSeen(userId, name) ?? []) {
                if (t.readOnly === true && t.destructive !== true) setPolicy(name, t.name, "allow", false);
            }
        }
    }

    // The built-in servers: the host's own (PiKVM computer use) and the user's other conversations. Their names are
    // reserved, so a configured server with the same name never reaches here.
    const builtins = listBuiltinMcp().map((b) => ({ name: b.name, tools: b.tools }));
    if (setting("agent.conversationsTool", userId)) builtins.push({ name: "conversations", tools: [] });
    for (const b of builtins) {
        mcpServers[b.name] = {
            type: "http",
            url: `${gatewayBase}/mcp/${b.name}`,
            headers: {
                Authorization: `Bearer ${gatewayToken(userId)}`,
                "X-Chat-Conversation": "${CHAT_CONVERSATION_ID}",
            },
            timeout: GATEWAY_TIMEOUT_MS,
        };
        // A built-in server asks for approval itself (MCP elicitation in the thread), where the arguments are visible.
        for (const tool of b.tools) setPolicy(b.name, tool, "allow");
    }

    // A tool turned off in agent.disabledTools stays off whatever its server entry says.
    const disabled = setting("agent.disabledTools", userId);
    const keep = new Set<string>(COMPUTER_TOOLS);
    const denied = RUNTIME_TOOLS.filter((t) => !keep.has(t));
    const approval: Record<string, string> = {
        ...Object.fromEntries(denied.map((t) => [t, "deny"])),
        ...toolPolicies,
        ...Object.fromEntries(disabled.map((t) => [t, "deny"])),
    };
    const options = runtimeOptions(userId);
    const base = {
        ...toolSwitchesOff([...SWITCHED_TOOLS.filter((t) => !keep.has(t))]),
        // Memory is off: nothing is recalled into a chat and nothing is retained from it.
        memory: { backend: "off" },
        ...(Object.keys(options.modelRoles).length ? { modelRoles: options.modelRoles } : {}),
        disabledProviders: IMPLICIT_LOCAL.filter((id) => !(id in providers)),
        tools: { approvalMode: "write", approval, xdev: false },
        // The working directory is the agent's own; a project config written there must not add servers or tools.
        mcp: { enableProjectConfig: false },
        // Subagents and long commands run inside the turn, so progress streams and cancel stops them.
        async: { enabled: false },
        // Questions from the `ask` tool: the runtime enforces the timeout and then takes the recommended option.
        ask: { timeout: setting("agent.askTimeoutSec", userId), notify: "off" },
    };
    const config: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(options.config)) {
        const prev = config[k];
        config[k] = isRecord(prev) && isRecord(v) ? { ...prev, ...v } : v;
    }
    // Bound the retries inside one turn (retry-limits.ts).
    config.retry = { ...(isRecord(config.retry) ? config.retry : {}), ...retryConfig() };

    const models = { providers };
    const mcp = { mcpServers };
    const hash = createHash("sha256")
        .update(JSON.stringify([models, mcp, config]))
        .digest("hex")
        .slice(0, 16);
    return { models, mcp, config, hash, skipped };
}

/** Write the rendered files. The directories are private to the agent's user and created here. */
export function writeAgentConfig(userId: string, gatewayBase: string): RenderedConfig {
    const r = renderAgentConfig(userId, gatewayBase);
    const p = paths.user(userId);
    mkdirSync(p.ompAgentDir, { recursive: true });
    for (const dir of [p.workspace, p.uploads, p.conversations]) mkdirSync(dir, { recursive: true });
    // The config holds only the gateway token, but it is still not for other local users.
    writeFileSync(p.ompModels, JSON.stringify(r.models, null, 2), { mode: 0o600 });
    writeFileSync(p.ompMcp, JSON.stringify(r.mcp, null, 2), { mode: 0o600 });
    writeFileSync(p.ompConfig, JSON.stringify(r.config, null, 2), { mode: 0o600 });
    return r;
}
