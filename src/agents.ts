/**
 * Agent registry for the multi-tab terminal. Each tab runs one of these CLI agents in the
 * vault, all driving PiKVM through the same eyes+hands MCP server. Claude uses its native
 * .mcp.json + PreToolUse guardrail hook; codex/opencode get the MCP wired in their own
 * config format and are gated by the MCP server's per-session KVM control lease (they have
 * no equivalent of Claude's hook).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type AgentKind = "claude" | "codex" | "opencode";

export interface AgentSpec {
    kind: AgentKind;
    label: string;
    bin: string;
    args: string[];
}

export interface AgentBuildCtx {
    sessionId: string;
    /** CONTROL_PORT — the local backend serving /_agent/* + /mcp. */
    port: number;
}

const resolveBin = (cands: Array<string | undefined>): string => {
    const list = cands.filter(Boolean) as string[];
    for (const c of list) if (existsSync(c)) return c;
    return list[list.length - 1] ?? list[0] ?? "";
};

/** Per-session MCP endpoint — the session id in the path lets the server enforce the
 *  single-controller KVM lease for agents without a Claude-style permission hook. */
export const mcpUrlFor = (port: number, sessionId: string): string => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(sessionId)}`;

export const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };

export function buildAgentSpec(kind: AgentKind, ctx: AgentBuildCtx): AgentSpec {
    switch (kind) {
        case "codex":
            return {
                kind,
                label: AGENT_LABELS.codex,
                bin: resolveBin([process.env.CODEX_BIN, join(homedir(), ".local/bin/codex"), "codex"]),
                // Inject the pikvm MCP per-invocation so we never touch the user's global
                // ~/.codex/config.toml. Codex parses dotted -c keys into config.toml structure.
                args: ["-c", `mcp_servers.pikvm.url="${mcpUrlFor(ctx.port, ctx.sessionId)}"`],
            };
        case "opencode":
            return {
                kind,
                label: AGENT_LABELS.opencode,
                bin: resolveBin([process.env.OPENCODE_BIN, join(homedir(), "bin/opencode"), join(homedir(), ".local/bin/opencode"), "opencode"]),
                // opencode reads <vault>/opencode.json (written by writeOpencodeConfig).
                args: [],
            };
        case "claude":
        default:
            return {
                kind,
                label: AGENT_LABELS.claude,
                bin: resolveBin([process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude"), "claude"]),
                // claude reads <vault>/.mcp.json + .claude/settings.json (the guardrail hook).
                args: [],
            };
    }
}

/** True if this agent is installed (so the picker can disable missing ones). */
export function agentAvailable(kind: AgentKind): boolean {
    const spec = buildAgentSpec(kind, { sessionId: "_probe", port: 0 });
    return existsSync(spec.bin) || !spec.bin.includes("/"); // bare PATH name → assume present
}

/**
 * Write the pikvm MCP server into the vault's opencode.json for an opencode session. Each
 * opencode tab is written just before it spawns, so it reads its own per-session /mcp/<id>
 * URL at startup (opencode reads config once, so concurrent tabs keep their own). Existing
 * keys in opencode.json are preserved.
 */
export function writeOpencodeConfig(vaultPath: string, port: number, sessionId: string): void {
    mkdirSync(vaultPath, { recursive: true });
    const path = join(vaultPath, "opencode.json");
    let cfg: Record<string, any> = {};
    if (existsSync(path)) {
        try {
            cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
        } catch {
            cfg = {};
        }
    }
    cfg.$schema = cfg.$schema || "https://opencode.ai/config.json";
    cfg.mcp = cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {};
    cfg.mcp.pikvm = { type: "remote", url: mcpUrlFor(port, sessionId), enabled: true };
    writeFileSync(path, JSON.stringify(cfg, null, 2));
}
