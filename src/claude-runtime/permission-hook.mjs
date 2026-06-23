#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — the GUARDRAIL bridge.
 *
 * Configured (in the vault's .claude/settings.json) to match `mcp__pikvm__*`. Before
 * Claude Code runs a PiKVM MCP tool, it pipes the call as JSON on stdin to this script.
 * We forward {tool, args} to the app's /api/permcheck, which runs OUR safety brain
 * (sensitive-area vision check + dangerous-command + autonomy dial) and answers
 * allow | ask | deny. We translate that into Claude Code's permission decision:
 *   - allow → run without a prompt
 *   - ask   → Claude Code shows its in-terminal permission prompt
 *   - deny  → blocked, with the reason surfaced to the model
 *
 * FAIL-CLOSED: if the guardrail server is unreachable, we DENY — nothing acts unguarded.
 *
 * Env: PIKVM_PERMCHECK_URL (set by the app when it spawns claude).
 */

function emit(permissionDecision, reason) {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision,
                permissionDecisionReason: reason || "",
            },
        }),
    );
    process.exit(0);
}

async function main() {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;

    let input;
    try {
        input = JSON.parse(raw || "{}");
    } catch {
        emit("deny", "PiKVM guardrail: could not parse the tool call.");
        return;
    }

    const toolName = String(input.tool_name || input.toolName || "");
    // Only gate our PiKVM MCP tools; let Claude Code's own rules handle everything else.
    if (!/^mcp__pikvm__/.test(toolName)) {
        process.exit(0); // no decision → Claude Code's default applies
        return;
    }

    const url = process.env.PIKVM_PERMCHECK_URL;
    if (!url) {
        emit("deny", "PiKVM guardrail not configured (PIKVM_PERMCHECK_URL unset).");
        return;
    }

    const args = input.tool_input || input.toolInput || {};
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // PIKVM_SESSION_ID identifies which tab/agent session this is, so the server
            // can enforce the single-controller KVM lease (one session drives at a time).
            body: JSON.stringify({ tool: toolName, args, session: process.env.PIKVM_SESSION_ID || "" }),
            signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) {
            emit("deny", `PiKVM guardrail server returned ${r.status}.`);
            return;
        }
        const out = await r.json();
        const decision = out.decision === "allow" || out.decision === "deny" ? out.decision : "ask";
        emit(decision, out.reason || "");
    } catch {
        // Server down / timeout → fail closed.
        emit("deny", "PiKVM guardrail server unreachable — action blocked for safety.");
    }
}

void main();
