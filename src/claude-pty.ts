/**
 * Claude Code PTY host (main process).
 *
 * Spawns the `claude` CLI in a pseudo-terminal (@lydell/node-pty — prebuilt N-API, no
 * Electron rebuild) and relays its I/O to the embedded xterm.js terminal via IPC. The
 * CLI runs in the vault folder (cwd) where the app has written .mcp.json (the pikvm MCP
 * server) + .claude/settings.json (the PreToolUse guardrail hook + permissions). Claude
 * Code's own permission prompts handle approvals — we never pass --dangerously-skip-permissions.
 */

import * as pty from "@lydell/node-pty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClaudeTerminalOpts {
    /** Working dir = the vault folder. */
    cwd: string;
    /** Extra env (e.g. PIKVM_PERMCHECK_URL for the hook). Merged over process.env. */
    env?: Record<string, string>;
    /** Override the claude binary (else CLAUDE_BIN → ~/.local/bin/claude → PATH). */
    bin?: string;
    /** Launch args (e.g. codex's per-session MCP override). Default: none. */
    args?: string[];
    cols?: number;
    rows?: number;
}

/** Resolve the claude binary: explicit → CLAUDE_BIN env → common user path → PATH name. */
export function resolveClaudeBin(override?: string): string {
    const cands = [override, process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude")].filter(Boolean) as string[];
    for (const c of cands) if (existsSync(c)) return c;
    return "claude"; // let the PATH resolve it
}

export class ClaudeTerminal {
    private proc: pty.IPty | null = null;
    private dataCbs: Array<(d: string) => void> = [];
    private exitCbs: Array<(info: { code: number; signal?: number }) => void> = [];
    private cols: number;
    private rows: number;

    constructor(private opts: ClaudeTerminalOpts) {
        this.cols = opts.cols ?? 120;
        this.rows = opts.rows ?? 30;
    }

    /** Spawn the CLI (idempotent). Returns ok:false with a reason if it can't start. */
    start(): { ok: boolean; reason?: string } {
        if (this.proc) return { ok: true };
        const bin = resolveClaudeBin(this.opts.bin);
        try {
            this.proc = pty.spawn(bin, this.opts.args ?? [], {
                name: "xterm-256color",
                cols: this.cols,
                rows: this.rows,
                cwd: this.opts.cwd,
                env: { ...process.env, ...(this.opts.env ?? {}), TERM: "xterm-256color", COLORTERM: "truecolor" },
            });
            this.proc.onData((d) => {
                for (const cb of this.dataCbs) cb(d);
            });
            this.proc.onExit((e) => {
                this.proc = null;
                for (const cb of this.exitCbs) cb({ code: e.exitCode, ...(e.signal != null ? { signal: e.signal } : {}) });
            });
            return { ok: true };
        } catch (e: any) {
            this.proc = null;
            return { ok: false, reason: String(e?.message ?? e) };
        }
    }

    /** User keystrokes from xterm → CLI stdin. */
    write(data: string): void {
        this.proc?.write(data);
    }

    /** Inject a line of text + Enter (e.g. a tapped suggestion's task) as if typed. */
    submitLine(text: string): void {
        if (!this.proc) return;
        this.proc.write(text.replace(/[\r\n]+/g, " "));
        this.proc.write("\r");
    }

    resize(cols: number, rows: number): void {
        this.cols = Math.max(2, Math.floor(cols) || this.cols);
        this.rows = Math.max(2, Math.floor(rows) || this.rows);
        try {
            this.proc?.resize(this.cols, this.rows);
        } catch {
            /* resizing a dead pty throws — ignore */
        }
    }

    onData(cb: (d: string) => void): () => void {
        this.dataCbs.push(cb);
        return () => (this.dataCbs = this.dataCbs.filter((c) => c !== cb));
    }

    onExit(cb: (info: { code: number; signal?: number }) => void): () => void {
        this.exitCbs.push(cb);
        return () => (this.exitCbs = this.exitCbs.filter((c) => c !== cb));
    }

    kill(): void {
        try {
            this.proc?.kill();
        } catch {
            /* ignore */
        }
        this.proc = null;
    }

    get running(): boolean {
        return !!this.proc;
    }
}
