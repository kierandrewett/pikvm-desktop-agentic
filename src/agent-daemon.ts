/**
 * Background launcher for the PiKVM Agent Python daemon (the transactional
 * computer-use runtime at ~/dev/pikvm-agent). The desktop app spawns it on
 * startup so Claude Code / Codex can drive guarded sessions over the pikvm MCP
 * server (a thin facade that forwards to this daemon), and embeds the daemon's
 * web console. Credentials are forwarded as env vars at spawn time so the user
 * never re-enters them.
 *
 * Mirrors the child_process.spawn pattern in doc-capture.ts (not node-pty — this
 * is a long-running server, not an interactive TTY).
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

/** Where the pikvm-agent repo (with its .venv) lives. Override with PIKVM_AGENT_DIR. */
const DEFAULT_DAEMON_DIR = "/home/kieran/dev/pikvm-agent";

function resolvePython(daemonDir: string): string {
    if (process.env.PIKVM_AGENT_PYTHON) return process.env.PIKVM_AGENT_PYTHON;
    const venv = resolve(daemonDir, ".venv", "bin", "python");
    if (existsSync(venv)) return venv;
    return "python3";
}

export type DaemonEnv = Record<string, string | undefined>;

export class AgentDaemon {
    private proc: ChildProcess | null = null;
    private readonly dir: string;
    private readonly python: string;

    constructor(opts: { dir?: string } = {}) {
        this.dir = process.env.PIKVM_AGENT_DIR || opts.dir || DEFAULT_DAEMON_DIR;
        this.python = resolvePython(this.dir);
    }

    get running(): boolean {
        return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
    }

    /**
     * Build the env (async — it reads the live PiKVM auth cookie) then spawn the
     * daemon via the CLI (`python -m pikvm_agent.cli daemon` → uvicorn). Spawning
     * `-m pikvm_agent.daemon` would only define the app, not serve it.
     */
    async start(buildEnv: () => Promise<DaemonEnv>): Promise<void> {
        if (this.running) return;
        if (!existsSync(this.dir)) {
            console.warn(`[pikvm-agent] daemon dir not found: ${this.dir} — not starting`);
            return;
        }
        let extra: DaemonEnv = {};
        try {
            extra = await buildEnv();
        } catch (err) {
            console.error("[pikvm-agent] env build failed:", err);
        }
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const [k, v] of Object.entries(extra)) {
            if (v != null && v !== "") env[k] = v;
        }
        try {
            this.proc = spawn(this.python, ["-m", "pikvm_agent.cli", "daemon"], {
                cwd: this.dir,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (err) {
            console.error("[pikvm-agent] spawn failed:", err);
            this.proc = null;
            return;
        }
        const log = (buf: Buffer) => {
            for (const line of buf.toString().split(/\r?\n/)) {
                if (line.trim()) console.log("[pikvm-agent]", line);
            }
        };
        this.proc.stdout?.on("data", log);
        this.proc.stderr?.on("data", log);
        this.proc.on("exit", (code, sig) => {
            console.log(`[pikvm-agent] daemon exited (code=${code} sig=${sig})`);
            this.proc = null;
        });
        console.log(`[pikvm-agent] daemon spawned: ${this.python} -m pikvm_agent.cli daemon (cwd=${this.dir})`);
    }

    kill(): void {
        const p = this.proc;
        this.proc = null;
        if (!p || p.exitCode !== null) return;
        try {
            p.kill("SIGTERM");
        } catch {
            /* already gone */
        }
        const t = setTimeout(() => {
            try {
                if (p.exitCode === null) p.kill("SIGKILL");
            } catch {
                /* ignore */
            }
        }, 3000);
        t.unref?.();
    }
}
