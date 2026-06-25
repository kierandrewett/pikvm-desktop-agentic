/**
 * Lifecycle manager for the pikvm-agent daemon.
 *
 * The native Agent panel (the sidebar's Agent tab) is a front-end for the daemon's
 * HTTP API, so the desktop app owns the daemon's lifecycle: spawn it on startup,
 * stop it on quit. We do NOT double-spawn — if a daemon is already listening (the
 * user started one, or a previous instance), we adopt it and leave it running on
 * quit. A daemon we DID spawn is killed on quit and auto-restarted if it dies
 * unexpectedly (capped, so a crash-loop can't run away).
 *
 * The daemon is a separate Python process; it loads its own XDG config + .env, so we
 * just launch the command and inherit the environment.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";

export interface DaemonManagerDeps {
    /** Daemon base URL, e.g. http://127.0.0.1:47615. */
    origin: string;
    /** Executable to run (e.g. /…/pikvm-agent or python). */
    command: string;
    /** Arguments (e.g. ["daemon"] or ["-m", "pikvm_agent.daemon"]). */
    args: string[];
    /** Working directory for the daemon (optional). */
    cwd?: string;
    /** Log sink for daemon stdout/stderr + lifecycle messages. */
    log?: (line: string) => void;
}

const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 5; // within a session — beyond this we give up (likely misconfigured)

export class DaemonManager {
    private child: ChildProcess | null = null;
    private spawnedByUs = false;
    private stopping = false;
    private restarts = 0;
    private restartTimer: NodeJS.Timeout | null = null;

    constructor(private readonly deps: DaemonManagerDeps) {}

    private log(line: string) {
        this.deps.log?.(line);
    }

    /** GET <origin>/healthz → true on a 2xx within the timeout. */
    healthy(timeoutMs = 1500): Promise<boolean> {
        return new Promise((resolve) => {
            const req = httpGet(`${this.deps.origin}/healthz`, (res) => {
                res.resume(); // drain
                resolve((res.statusCode ?? 500) < 300);
            });
            req.setTimeout(timeoutMs, () => req.destroy());
            req.on("error", () => resolve(false));
        });
    }

    /** Start the daemon unless one is already listening (then we adopt it). */
    async start(): Promise<void> {
        if (this.child || this.stopping) return;
        if (await this.healthy()) {
            this.log(`[daemon] already running at ${this.deps.origin} — adopting (won't manage its lifecycle)`);
            return;
        }
        this.spawn();
    }

    private spawn() {
        const { command, args, cwd } = this.deps;
        this.log(`[daemon] starting: ${command} ${args.join(" ")}`);
        let child: ChildProcess;
        try {
            child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            this.log(`[daemon] failed to spawn (${String(err)}) — is the command path correct?`);
            return;
        }
        this.child = child;
        this.spawnedByUs = true;
        child.stdout?.on("data", (d: Buffer) => this.log(`[daemon] ${d.toString().trimEnd()}`));
        child.stderr?.on("data", (d: Buffer) => this.log(`[daemon] ${d.toString().trimEnd()}`));
        child.on("exit", (code, signal) => {
            this.child = null;
            if (this.stopping) return;
            this.log(`[daemon] exited unexpectedly (code=${code} signal=${signal})`);
            if (this.restarts >= MAX_RESTARTS) {
                this.log(`[daemon] giving up after ${MAX_RESTARTS} restarts — check the daemon config/command`);
                return;
            }
            this.restarts++;
            this.restartTimer = setTimeout(() => {
                if (!this.stopping) this.spawn();
            }, RESTART_DELAY_MS);
        });
    }

    /** Stop the daemon we spawned (no-op for an adopted one). */
    stop() {
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.child && this.spawnedByUs) {
            this.log("[daemon] stopping (app quit)");
            this.child.kill("SIGTERM");
            this.child = null;
        }
    }
}
