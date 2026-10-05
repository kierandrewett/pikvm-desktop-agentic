/* The desktop's half of the `pikvm` MCP server.
 *
 * Failure modes, written before the code:
 * 1. The ticket or its directory can be read by other users.
 * 2. A ticket left by an earlier run is not replaced.
 * 3. Quitting removes a ticket a newer desktop run already replaced.
 * 4. A runtime path with spaces or quotes breaks a wrapper ("PiKVM Desktop"
 *    is in the default settings path).
 * 5. The agent wrapper drops or reorders arguments.
 * 6. The server wrapper does not pass the ticket, so the server has no tools.
 * 7. No runtime found: no wrappers, but nothing throws.
 * 8. TypeScript and Python disagree on the ticket format (checked by running
 *    the real gui_gate.verify against a ticket written here, from a process
 *    whose ancestor this test is, and from one whose ancestor it is not).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareGuiMcp, SERVER_WRAPPER } from "../src/gui-mcp";

function scratch(): string {
    return mkdtempSync(join(tmpdir(), "pikvm gui'mcp "));
}

function fakeAgent(dir: string): string {
    const target = join(dir, "real agent's bin");
    writeFileSync(target, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
    chmodSync(target, 0o700);
    return target;
}

test("ticket is owner-only and names this desktop", () => {
    const dir = join(scratch(), "gui-mcp");
    try {
        prepareGuiMcp({ directory: dir, agentCommand: null, pid: 4242 });
        const ticket = join(dir, "gui-mcp.json");
        assert.equal(statSync(dir).mode & 0o077, 0);
        assert.equal(statSync(ticket).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(readFileSync(ticket, "utf8")), { schema_version: 2, desktop_pid: 4242 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a new run replaces an old ticket, and the old run's quit leaves it alone", () => {
    const dir = scratch();
    const ticket = join(dir, "gui-mcp.json");
    try {
        const old = prepareGuiMcp({ directory: dir, agentCommand: null, pid: 1111 });
        const fresh = prepareGuiMcp({ directory: dir, agentCommand: null, pid: 2222 });
        assert.equal(JSON.parse(readFileSync(ticket, "utf8")).desktop_pid, 2222);
        old.dispose();
        assert.ok(existsSync(ticket));
        fresh.dispose();
        assert.ok(!existsSync(ticket));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the wrappers run the real command with every argument intact", () => {
    const dir = scratch();
    try {
        const gui = prepareGuiMcp({ directory: join(dir, "gui-mcp"), agentCommand: fakeAgent(dir) });
        assert.equal(gui.path.length, 1);
        const agent = spawnSync(join(gui.path[0]!, "pikvm-agent"), ["cua", "two words", "it's"], {
            encoding: "utf8",
        });
        assert.equal(agent.status, 0, agent.stderr);
        assert.equal(agent.stdout, "[cua][two words][it's]");

        assert.equal(gui.serverCommand, join(gui.path[0]!, SERVER_WRAPPER));
        const server = spawnSync(gui.serverCommand!, [], { encoding: "utf8" });
        assert.equal(server.status, 0, server.stderr);
        assert.equal(server.stdout, `[gui-mcp][--ticket][${join(dir, "gui-mcp", "gui-mcp.json")}]`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no runtime means no wrappers and no error", () => {
    const dir = scratch();
    try {
        const gui = prepareGuiMcp({ directory: dir, agentCommand: null });
        assert.deepEqual(gui.path, []);
        assert.equal(gui.serverCommand, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// scripts/test.mjs runs the bundled tests with the repository root as cwd.
const agentPython = resolve(process.cwd(), "agent", ".venv", "bin", "python");

test(
    "Python's gui_gate accepts this desktop as an ancestor, and refuses another process",
    { skip: !existsSync(agentPython) && "agent/.venv is not set up" },
    async () => {
        const dir = scratch();
        const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
        try {
            const check = (ticketDir: string) =>
                spawnSync(
                    agentPython,
                    ["-c", "import sys; from pikvm_agent.cua import gui_gate; gui_gate.verify(sys.argv[1]); print('ok')",
                        join(ticketDir, "gui-mcp.json")],
                    { encoding: "utf8" },
                );
            // This test process is the python child's parent, so it is an ancestor.
            prepareGuiMcp({ directory: join(dir, "mine"), agentCommand: null });
            const ok = check(join(dir, "mine"));
            assert.equal(ok.stdout.trim(), "ok", ok.stderr);

            prepareGuiMcp({ directory: join(dir, "theirs"), agentCommand: null, pid: stranger.pid! });
            const refused = check(join(dir, "theirs"));
            assert.notEqual(refused.status, 0);
            assert.match(refused.stderr, /sidebar/);
        } finally {
            stranger.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
