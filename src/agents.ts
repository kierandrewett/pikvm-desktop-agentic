/**
 * Process registry for the shared terminal. The default tab is a plain user shell.
 * Agent CLIs remain supported internally for existing config writers, but they are
 * not exposed as terminal launch choices.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServerSettings } from "./settings";

export type AgentKind = "shell" | "claude" | "codex" | "opencode";

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
    /** Per-app-session bearer embedded only into this terminal workspace. */
    mcpToken?: string;
}

const resolveBin = (cands: Array<string | undefined>): string => {
    const list = cands.filter(Boolean) as string[];
    for (const c of list) if (existsSync(c)) return c;
    return list[list.length - 1] ?? list[0] ?? "";
};

/** Per-session MCP endpoint — the session id in the path lets the server enforce the
 *  single-controller KVM lease for agents without a Claude-style permission hook. */
export const mcpUrlFor = (port: number, sessionId: string, token?: string): string => {
    const u = `http://127.0.0.1:${port}/mcp/${encodeURIComponent(sessionId)}`;
    return token ? `${u}?pikvm_mcp_token=${encodeURIComponent(token)}` : u;
};

export const AGENT_LABELS: Record<AgentKind, string> = { shell: "Shell", claude: "Claude", codex: "Codex", opencode: "opencode" };

export function buildAgentSpec(kind: AgentKind, ctx: AgentBuildCtx): AgentSpec {
    switch (kind) {
        case "shell":
            return {
                kind,
                label: AGENT_LABELS.shell,
                bin: resolveBin([process.env.PIKVM_TERMINAL_SHELL, process.env.SHELL, "/bin/bash", "/bin/sh", "sh"]),
                args: [],
            };
        case "codex":
            return {
                kind,
                label: AGENT_LABELS.codex,
                bin: resolveBin([process.env.CODEX_BIN, join(homedir(), ".local/bin/codex"), "codex"]),
                // Inject the pikvm MCP per-invocation so we never touch the user's global
                // ~/.codex/config.toml. Codex parses dotted -c keys into config.toml structure.
                args: ["-c", `mcp_servers.pikvm.url="${mcpUrlFor(ctx.port, ctx.sessionId, ctx.mcpToken)}"`],
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
export function writeOpencodeConfig(vaultPath: string, port: number, sessionId: string, mcpToken?: string): void {
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
    cfg.mcp.pikvm = { type: "remote", url: mcpUrlFor(port, sessionId, mcpToken), enabled: true };
    writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
    return `[${values.map((v) => tomlString(v)).join(",")}]`;
}

function codexMcpServerKey(id: string): string {
    if (id === "atlas") return "atlas-mw";
    return (
        id
            .trim()
            .replace(/[^a-z0-9_-]+/gi, "-")
            .replace(/^-+|-+$/g, "") || "server"
    );
}

export function buildCodexMcpConfigArgs(servers: McpServerSettings[] | undefined): string[] {
    const args: string[] = [];
    for (const server of servers ?? []) {
        if (!server.enabled || server.id === "pikvm") continue;
        const key = codexMcpServerKey(server.id || server.name);
        const prefix = `mcp_servers.${key}`;
        if (server.transport === "http") {
            const url = server.url?.trim();
            if (!url) continue;
            args.push(`${prefix}.url=${tomlString(url)}`);
        } else {
            const command = server.command?.trim();
            if (!command) continue;
            args.push(`${prefix}.command=${tomlString(command)}`);
            const cleanArgs = (server.args ?? []).map((a) => a.trim()).filter(Boolean);
            if (cleanArgs.length) args.push(`${prefix}.args=${tomlStringArray(cleanArgs)}`);
        }
    }
    return args;
}

/**
 * Project-local wrappers for the generic shell. They make `codex` pick up the
 * PiKVM MCP URL without touching ~/.codex/config.toml, and keep `claude` using
 * the project-local .mcp.json / CLAUDE.md written beside them.
 */
export function writeLocalAgentWrappers(vaultPath: string, port: number, mcpToken: string, mcpServers?: McpServerSettings[]): void {
    const binDir = join(vaultPath, ".pikvm", "bin");
    mkdirSync(binDir, { recursive: true });
    const codexMcpArgs = buildCodexMcpConfigArgs(mcpServers)
        .map((arg) => ` \\\n  -c ${shQuote(arg)}`)
        .join("");
    const scripts: Record<string, string> = {
        claude: `#!/bin/sh
export PATH="\${PIKVM_ORIGINAL_PATH:-$PATH}"
mcp_config="\${PIKVM_WORKSPACE:-$PWD}/.mcp.json"
if [ -f "$mcp_config" ]; then
  exec claude --strict-mcp-config --mcp-config="$mcp_config" "$@"
fi
exec claude "$@"
`,
        codex: `#!/bin/sh
export PATH="\${PIKVM_ORIGINAL_PATH:-$PATH}"
session="\${PIKVM_SESSION_ID:-codex}"
url="http://127.0.0.1:${port}/mcp/\${session}?pikvm_mcp_token=${encodeURIComponent(mcpToken)}"
exec codex \\
  -c "mcp_servers.pikvm.url=\\"\${url}\\""${codexMcpArgs} \\
  "$@"
`,
    };
    for (const [name, body] of Object.entries(scripts)) {
        const p = join(binDir, name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
    }
}
