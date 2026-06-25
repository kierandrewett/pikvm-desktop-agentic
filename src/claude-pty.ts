/**
 * PTY host for the shared terminal.
 *
 * Spawns a shell or CLI in a pseudo-terminal (@lydell/node-pty - prebuilt N-API,
 * no Electron rebuild) and relays its I/O to xterm.js clients. The process runs
 * in the vault folder so manual shell work and optional CLIs share the same cwd.
 */

import * as pty from "@lydell/node-pty";
import { existsSync } from "node:fs";

export interface PtyTerminalOpts {
    /** Working dir = the vault folder. */
    cwd: string;
    /** Extra env (e.g. PIKVM_PERMCHECK_URL for the hook). Merged over process.env. */
    env?: Record<string, string>;
    /** Process to spawn. Bare names are resolved by PATH. */
    bin?: string;
    /** Launch args (e.g. codex's per-session MCP override). Default: none. */
    args?: string[];
    cols?: number;
    rows?: number;
}

/** Resolve the process binary: explicit wins; bare names are left for PATH. */
export function resolvePtyBin(override?: string): string {
    if (override) return override;
    const cands = [process.env.PIKVM_TERMINAL_SHELL, process.env.SHELL].filter(Boolean) as string[];
    for (const c of cands) if (existsSync(c)) return c;
    return process.platform === "win32" ? "cmd.exe" : "sh";
}

export class PtyTerminal {
    private proc: pty.IPty | null = null;
    private dataCbs: Array<(d: string) => void> = [];
    private exitCbs: Array<(info: { code: number; signal?: number }) => void> = [];
    private titleCbs: Array<(title: string) => void> = [];
    private oscCarry = "";
    private cols: number;
    private rows: number;

    constructor(private opts: PtyTerminalOpts) {
        this.cols = opts.cols ?? 120;
        this.rows = opts.rows ?? 30;
    }

    /** Spawn the CLI (idempotent). Returns ok:false with a reason if it can't start. */
    start(): { ok: boolean; reason?: string } {
        if (this.proc) return { ok: true };
        const bin = resolvePtyBin(this.opts.bin);
        try {
            this.proc = pty.spawn(bin, this.opts.args ?? [], {
                name: "xterm-256color",
                cols: this.cols,
                rows: this.rows,
                cwd: this.opts.cwd,
                env: { ...process.env, ...(this.opts.env ?? {}), TERM: "xterm-256color", COLORTERM: "truecolor" },
            });
            this.proc.onData((d) => {
                this.extractTitle(d);
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

    /** Shells commonly set the terminal/window title with OSC 0/1/2 escape codes. */
    private extractTitle(data: string): void {
        let text = this.oscCarry + data;
        this.oscCarry = "";
        let from = 0;
        for (;;) {
            const start = text.indexOf("\x1b]", from);
            if (start < 0) {
                if (text.endsWith("\x1b")) this.oscCarry = "\x1b";
                return;
            }
            const payloadStart = start + 2;
            const bel = text.indexOf("\x07", payloadStart);
            const st = text.indexOf("\x1b\\", payloadStart);
            let end = -1;
            let terminatorLen = 1;
            if (bel >= 0 && (st < 0 || bel < st)) {
                end = bel;
            } else if (st >= 0) {
                end = st;
                terminatorLen = 2;
            }
            if (end < 0) {
                this.oscCarry = text.slice(start, start + 2048);
                return;
            }
            const payload = text.slice(payloadStart, end);
            const sep = payload.indexOf(";");
            const op = sep >= 0 ? payload.slice(0, sep) : "";
            if ((op === "0" || op === "1" || op === "2") && sep >= 0) {
                const title = payload
                    .slice(sep + 1)
                    .replace(/[\x00-\x1f\x7f]/g, "")
                    .trim()
                    .slice(0, 160);
                if (title) for (const cb of this.titleCbs) cb(title);
            }
            from = end + terminatorLen;
            if (from >= text.length) return;
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

    onTitle(cb: (title: string) => void): () => void {
        this.titleCbs.push(cb);
        return () => (this.titleCbs = this.titleCbs.filter((c) => c !== cb));
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
