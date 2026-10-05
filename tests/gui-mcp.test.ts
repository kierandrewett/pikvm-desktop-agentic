/* The desktop's half of the GUI-only pikvm MCP server.
 *
 * Failure modes, written before the code:
 * 1. The ticket or its directory can be read by other users.
 * 2. The ticket stores the token itself instead of its hash.
 * 3. A ticket left by an earlier run is not replaced.
 * 4. Quitting removes a ticket a newer desktop run already replaced.
 * 5. A runtime path with spaces or quotes breaks the wrapper
 *    ("PiKVM Desktop" is in the default settings path).
 * 6. The wrapper drops or reorders arguments.
 * 7. No runtime found: no wrapper, but nothing throws.
 * 8. TypeScript and Python disagree on the ticket format (checked by running
 *    the real gui_gate.verify against a ticket written here).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareGuiMcp, TICKET_ENV, TOKEN_ENV } from "../src/gui-mcp";

function scratch(): string {
    return mkdtempSync(join(tmpdir(), "pikvm gui'mcp "));
}

test("ticket is owner-only and holds the token's hash, not the token", () => {
    const dir = join(scratch(), "gui-mcp");
    try {
        const gui = prepareGuiMcp({ directory: dir, agentCommand: null, pid: 4242 });
        const ticketPath = gui.env[TICKET_ENV]!;
        assert.equal(statSync(dir).mode & 0o077, 0);
        assert.equal(statSync(ticketPath).mode & 0o777, 0o600);
        const text = readFileSync(ticketPath, "utf8");
        assert.ok(!text.includes(gui.env[TOKEN_ENV]!));
        assert.equal(JSON.parse(text).desktop_pid, 4242);
        assert.match(gui.env[TOKEN_ENV]!, /^[0-9a-f]{64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a new run replaces an old ticket, and the old run's quit leaves it alone", () => {
    const dir = scratch();
    try {
        const old = prepareGuiMcp({ directory: dir, agentCommand: null, pid: 1111 });
        const fresh = prepareGuiMcp({ directory: dir, agentCommand: null, pid: 2222 });
        assert.equal(JSON.parse(readFileSync(fresh.env[TICKET_ENV]!, "utf8")).desktop_pid, 2222);
        old.dispose();
        assert.ok(existsSync(fresh.env[TICKET_ENV]!));
        fresh.dispose();
        assert.ok(!existsSync(fresh.env[TICKET_ENV]!));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the wrapper runs the real command with every argument intact", () => {
    const dir = scratch();
    try {
        const target = join(dir, "real agent's bin");
        writeFileSync(target, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
        chmodSync(target, 0o700);
        const gui = prepareGuiMcp({ directory: join(dir, "gui-mcp"), agentCommand: target });
        assert.equal(gui.path.length, 1);
        const wrapper = join(gui.path[0]!, "pikvm-agent");
        const out = spawnSync(wrapper, ["gui-mcp", "two words", "it's"], { encoding: "utf8" });
        assert.equal(out.status, 0, out.stderr);
        assert.equal(out.stdout, "[gui-mcp][two words][it's]");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no runtime means no wrapper and no error", () => {
    const dir = scratch();
    try {
        assert.deepEqual(prepareGuiMcp({ directory: dir, agentCommand: null }).path, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// scripts/test.mjs runs the bundled tests with the repository root as cwd.
const realPython = resolve(process.cwd(), "agent", ".venv", "bin", "python");

test(
    "Python's gui_gate accepts this ticket and token, and refuses a wrong token",
    { skip: !existsSync(realPython) && "agent/.venv is not set up" },
    () => {
        const dir = scratch();
        try {
            const gui = prepareGuiMcp({ directory: dir, agentCommand: null });
            const check = "from pikvm_agent.cua import gui_gate; gui_gate.verify(); print('ok')";
            const ok = spawnSync(realPython, ["-c", check], {
                encoding: "utf8",
                env: { ...process.env, ...gui.env },
            });
            assert.equal(ok.stdout.trim(), "ok", ok.stderr);
            const wrong = spawnSync(realPython, ["-c", check], {
                encoding: "utf8",
                env: { ...process.env, ...gui.env, [TOKEN_ENV]: "0".repeat(64) },
            });
            assert.notEqual(wrong.status, 0);
            assert.match(wrong.stderr, /another PiKVM Desktop run/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
