/**
 * The desktop's half of the GUI-only `pikvm` MCP server (agent/docs/CUA.md).
 *
 * At startup the desktop writes an owner-only ticket naming its own pid and the
 * SHA-256 of a fresh token, and hands the token itself only to the shells in
 * its terminal panel. An agent harness started in one of those shells launches
 * `pikvm-agent gui-mcp`, which checks the ticket (agent/pikvm_agent/cua/
 * gui_gate.py) and refuses anywhere else. The ticket format is shared with
 * that file; tests/gui-mcp.test.ts runs the Python check against a ticket
 * written here.
 *
 * The terminals also get a directory on PATH holding ONLY a `pikvm-agent`
 * wrapper. Putting the runtime's own bin directory on PATH would also put its
 * python3 there, and silently replace the user's python in every terminal.
 *
 * This keeps the server to the GUI. It is not a boundary against code running
 * as the same user, which can read another process's environment.
 */

import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const TOKEN_ENV = "PIKVM_GUI_MCP_TOKEN";
export const TICKET_ENV = "PIKVM_GUI_MCP_TICKET";
const TICKET_NAME = "gui-mcp.json";
const WRAPPER_NAME = "pikvm-agent";

export interface GuiMcp {
    /** Environment for every terminal session. */
    env: Record<string, string>;
    /** Directories to put in front of PATH in terminal sessions. */
    path: string[];
    /** Remove the ticket, unless a newer desktop run has replaced it. */
    dispose(): void;
}

export interface GuiMcpOptions {
    /** Owner-only directory for the ticket and the wrapper. */
    directory: string;
    /** The resolved pikvm-agent executable, or null when there is none. */
    agentCommand: string | null;
    pid?: number;
    platform?: NodeJS.Platform;
}

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Single-quote for sh: the only character that needs care is ' itself. */
function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writePrivate(path: string, content: string, mode: number): void {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
        writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

export function prepareGuiMcp(options: GuiMcpOptions): GuiMcp {
    const platform = options.platform ?? process.platform;
    const pid = options.pid ?? process.pid;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") chmodSync(options.directory, 0o700);

    const token = randomBytes(32).toString("hex");
    const tokenSha256 = sha256(token);
    const ticket = join(options.directory, TICKET_NAME);
    writePrivate(
        ticket,
        `${JSON.stringify({ schema_version: 1, desktop_pid: pid, token_sha256: tokenSha256 }, null, 2)}\n`,
        0o600,
    );

    const path: string[] = [];
    if (options.agentCommand && platform !== "win32") {
        const bin = join(options.directory, "bin");
        mkdirSync(bin, { recursive: true, mode: 0o700 });
        chmodSync(bin, 0o700);
        writePrivate(
            join(bin, WRAPPER_NAME),
            `#!/bin/sh\n# Written by PiKVM Desktop for its terminal panel.\nexec ${shQuote(options.agentCommand)} "$@"\n`,
            0o700,
        );
        path.push(bin);
    }

    return {
        env: { [TOKEN_ENV]: token, [TICKET_ENV]: ticket },
        path,
        dispose() {
            try {
                const current = JSON.parse(readFileSync(ticket, "utf8")) as { token_sha256?: unknown };
                if (current.token_sha256 === tokenSha256) unlinkSync(ticket);
            } catch {
                /* already gone, or unreadable: nothing of ours to remove */
            }
        },
    };
}
