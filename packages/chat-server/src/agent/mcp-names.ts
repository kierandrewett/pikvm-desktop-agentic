/**
 * The name the agent runtime gives an MCP tool (`mcp__<server>_<tool>`), so the config generator can key a per-tool
 * approval policy (`tools.approval`) without starting the server.
 *
 * This mirrors the runtime's own rule: lower case, runs of other characters become `_`, a tool name that repeats
 * the server name loses that prefix, and names over 64 characters keep a prefix plus a hash of the full name. The E2E suite (e2e/api/providers-mcp.test.ts) compares this with the names the runtime reports, so a
 * change in the runtime fails a test instead of silently dropping a policy.
 */

const MAX_LENGTH = 64;

function part(value: string, fallback: string): string {
    const clean = value
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return clean || fallback;
}

/**
 * The runtime hashes over-long names with Bun's wyhash, which Node cannot reproduce, so those names are not
 * predictable here and the result is `undefined`. Callers must then treat the tool as unknown (deny, never allow).
 */
export function mcpToolName(server: string, tool: string): string | undefined {
    const s = part(server, "server");
    let t = part(tool, "tool");
    if (t.startsWith(`${s}_`)) t = t.slice(s.length + 1);
    const name = `mcp__${s}_${t}`;
    if (name.length <= MAX_LENGTH) return name;
    return undefined;
}
