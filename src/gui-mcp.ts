/**
 * The desktop's half of the `pikvm` MCP server (agent/docs/CUA.md).
 *
 * Any agent harness started in the sidebar terminal can use it; nothing else
 * can. At startup the desktop writes an owner-only ticket naming its own pid,
 * and a wrapper, `<directory>/bin/pikvm-gui-mcp`, that runs
 * `pikvm-agent gui-mcp --ticket <that ticket>`. Harnesses register the wrapper
 * once, by its absolute path. The server offers tools only when this desktop
 * is one of its ancestors (agent/pikvm_agent/cua/gui_gate.py): a harness in the
 * sidebar is a child of our shell and spawns the server as its own child.
 *
 * Ancestry rather than an environment token, because harnesses filter what
 * they pass to MCP servers (Codex an allow-list, Gemini anything named TOKEN).
 * The ticket format is shared with gui_gate.py; tests/gui-mcp.test.ts runs the
 * Python check against a ticket written here.
 *
 * The sidebar's shells also get `<directory>/bin` on PATH, which holds only our
 * two wrappers. The runtime's own bin directory would also bring its python3,
 * and silently replace the user's python in every terminal.
 */

import { randomBytes } from "node:crypto";
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

const TICKET_NAME = "gui-mcp.json";
export const SERVER_WRAPPER = "pikvm-gui-mcp";
const AGENT_WRAPPER = "pikvm-agent";

export interface GuiMcp {
    /** The command harnesses register as their `pikvm` MCP server, or null. */
    serverCommand: string | null;
    /** Directories to put in front of PATH in terminal sessions. */
    path: string[];
    /** Remove the ticket, unless a newer desktop run has replaced it. */
    dispose(): void;
}

export interface GuiMcpOptions {
    /** Owner-only directory for the ticket and the wrappers. */
    directory: string;
    /** The resolved pikvm-agent executable, or null when there is none. */
    agentCommand: string | null;
    pid?: number;
    platform?: NodeJS.Platform;
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

    const ticket = join(options.directory, TICKET_NAME);
    writePrivate(ticket, `${JSON.stringify({ schema_version: 2, desktop_pid: pid }, null, 2)}\n`, 0o600);

    const path: string[] = [];
    let serverCommand: string | null = null;
    if (options.agentCommand && platform !== "win32") {
        const bin = join(options.directory, "bin");
        mkdirSync(bin, { recursive: true, mode: 0o700 });
        chmodSync(bin, 0o700);
        const agent = shQuote(options.agentCommand);
        const header = "#!/bin/sh\n# Written by PiKVM Desktop at every start; see src/gui-mcp.ts.\n";
        serverCommand = join(bin, SERVER_WRAPPER);
        writePrivate(serverCommand, `${header}exec ${agent} gui-mcp --ticket ${shQuote(ticket)}\n`, 0o700);
        writePrivate(join(bin, AGENT_WRAPPER), `${header}exec ${agent} "$@"\n`, 0o700);
        path.push(bin);
    }

    return {
        serverCommand,
        path,
        dispose() {
            try {
                const current = JSON.parse(readFileSync(ticket, "utf8")) as { desktop_pid?: unknown };
                if (current.desktop_pid === pid) unlinkSync(ticket);
            } catch {
                /* already gone, or unreadable: nothing of ours to remove */
            }
        },
    };
}
