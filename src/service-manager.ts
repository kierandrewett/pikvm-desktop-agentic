/** Lifecycle manager shared by the local daemon and operator harness. */

import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { parseEndpoint, endpointRequestOptions } from "./endpoint";

export interface ManagedServiceDeps {
    /** Human-readable name used in lifecycle logs. */
    name: string;
    /** Where the service is: an origin (http://127.0.0.1:47615) or a socket
     *  (unix:/…/daemon.sock). Both are accepted; see src/endpoint.ts. */
    origin: string;
    /** Unauthenticated health path. */
    healthPath: string;
    /** Executable to run (e.g. /…/pikvm-agent or python). */
    command: string;
    /** Arguments (e.g. ["daemon"] or ["-m", "pikvm_agent.daemon"]). */
    args: string[];
    /** Working directory for the child (optional). */
    cwd?: string;
    /** Child environment layered over the desktop process environment. */
    env?: NodeJS.ProcessEnv;
    /** Whether a healthy process not spawned by us can be adopted. */
    adoptExisting?: boolean;
    /** Log sink for child stdout/stderr + lifecycle messages. */
    log?: (line: string) => void;
    /** How long a child must survive before its start counts as recovered
     *  rather than as another turn of a crash loop. Overridable for tests;
     *  see STABLE_RUN_MS. */
    stableRunMs?: number;
}

const RESTART_DELAY_MS = 2000;
/* Consecutive rapid restarts before we stop trying. The point of the ceiling is
 * to catch a crash LOOP - a bad command, a missing venv, a config the service
 * refuses - not to ration restarts over the life of the app. */
const MAX_RESTARTS = 5;
/* How long a child gets to leave after SIGTERM before restart() kills it outright. */
const RESTART_KILL_MS = 5000;
/* Survive this long and the restart that produced you is deemed to have worked,
 * so the consecutive-failure count goes back to zero.
 *
 * Without it `restarts` only ever went up. The desktop stays open for days on a
 * KVM, so five unrelated crashes hours apart - each one restarted successfully,
 * each one recovered - reached the same ceiling as five in ten seconds, and the
 * daemon was then never restarted again for the rest of the session. The log
 * line even says "likely misconfigured", which is exactly what it would NOT
 * have been by then. */
const STABLE_RUN_MS = 60_000;

export type ManagedServiceStart = "started" | "adopted" | "conflict";

export class ManagedService {
    private child: ChildProcess | null = null;
    private spawnedByUs = false;
    private stopping = false;
    /** stop() was called: this service never starts again. */
    private stopped = false;
    private restarts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    /** When the current child started, so its lifetime can be judged on exit. */
    private spawnedAt = 0;

    constructor(private readonly deps: ManagedServiceDeps) {}

    private log(line: string) {
        this.deps.log?.(line);
    }

    /** GET the configured health endpoint → true on a 2xx within the timeout.
     *
     *  Built from request options rather than a URL, because a unix socket has
     *  no host:port for `new URL` to resolve the health path against. A bad
     *  endpoint string resolves false here rather than throwing: an unhealthy
     *  service is exactly what a misconfigured one is, and this is polled. */
    healthy(timeoutMs = 1500): Promise<boolean> {
        return new Promise((resolve) => {
            let options;
            try {
                const path = this.deps.healthPath.startsWith("/")
                    ? this.deps.healthPath
                    : `/${this.deps.healthPath}`;
                options = endpointRequestOptions(parseEndpoint(this.deps.origin), path, "GET", {});
            } catch {
                resolve(false);
                return;
            }
            const req = httpRequest(options, (res) => {
                res.resume(); // drain
                resolve((res.statusCode ?? 500) < 300);
            });
            req.setTimeout(timeoutMs, () => req.destroy());
            req.on("error", () => resolve(false));
            req.end();
        });
    }

    /** Start the child unless an allowed healthy service can be adopted. */
    async start(): Promise<ManagedServiceStart> {
        if (this.child) return "started";
        if (this.stopping) throw new Error(`${this.deps.name} is stopping`);
        if (await this.healthy()) {
            if (this.deps.adoptExisting === false) {
                this.log(
                    `[${this.deps.name}] healthy service already owns ${this.deps.origin}; refusing credential-blind adoption`,
                );
                return "conflict";
            }
            this.log(
                `[${this.deps.name}] already running at ${this.deps.origin} — adopting (won't manage its lifecycle)`,
            );
            return "adopted";
        }
        this.spawn();
        return "started";
    }

    private spawn() {
        const { command, args, cwd, env } = this.deps;
        this.log(`[${this.deps.name}] starting: ${command} ${args.join(" ")}`);
        this.spawnedAt = Date.now();
        let child: ChildProcess;
        try {
            child = spawn(command, args, {
                cwd,
                /* PIKVM_AGENT_PARENT_PID: the service (and anything it starts)
                 * exits when this process dies, so a crash or kill -9 of the app
                 * cannot leave it holding the sockets. See parent_watch.py. */
                env: { ...process.env, ...env, PIKVM_AGENT_PARENT_PID: String(process.pid) },
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (err) {
            this.log(
                `[${this.deps.name}] failed to spawn (${String(err)}) — is the command path correct?`,
            );
            return;
        }
        this.child = child;
        this.spawnedByUs = true;
        child.stdout?.on("data", (d: Buffer) =>
            this.log(`[${this.deps.name}] ${d.toString().trimEnd()}`),
        );
        child.stderr?.on("data", (d: Buffer) =>
            this.log(`[${this.deps.name}] ${d.toString().trimEnd()}`),
        );
        child.on("error", (err) => {
            this.log(`[${this.deps.name}] failed to spawn: ${String(err)}`);
        });
        child.on("exit", (code, signal) => {
            this.child = null;
            if (this.stopping) return;
            this.log(
                `[${this.deps.name}] exited unexpectedly (code=${code} signal=${signal})`,
            );
            // A child that ran for a good while did not fail to START, so the
            // consecutive count starts again. Only back-to-back failures are a
            // loop, and only a loop is what the ceiling is for.
            const ranForMs = this.spawnedAt ? Date.now() - this.spawnedAt : 0;
            const stableRunMs = this.deps.stableRunMs ?? STABLE_RUN_MS;
            if (this.restarts > 0 && ranForMs >= stableRunMs) {
                // Milliseconds under a second: "ran 0s" is what a sub-second
                // lifetime rounded to, which reads as the opposite of stable.
                const lived = ranForMs >= 1000 ? `${Math.round(ranForMs / 1000)}s` : `${ranForMs}ms`;
                this.log(`[${this.deps.name}] ran ${lived} before exiting — restart count reset`);
                this.restarts = 0;
            }
            if (this.restarts >= MAX_RESTARTS) {
                this.log(
                    `[${this.deps.name}] giving up after ${MAX_RESTARTS} rapid restarts — check its config/command`,
                );
                return;
            }
            this.restarts++;
            this.restartTimer = setTimeout(() => {
                if (!this.stopping) this.spawn();
            }, RESTART_DELAY_MS);
        });
    }

    async waitUntilHealthy(timeoutMs = 10_000, intervalMs = 100): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        do {
            if (await this.healthy(Math.min(intervalMs * 2, 1000))) return true;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        } while (Date.now() < deadline);
        return false;
    }

    /**
     * Start the child again with more environment, once the old one is gone: how a service
     * learns something it only reads at start (the PiKVM it drives). Resolves false when there
     * is nothing of ours to restart (it was adopted, or never started), true when a new child
     * was spawned. A service that was stopped for good stays stopped.
     */
    async restart(env: NodeJS.ProcessEnv = {}): Promise<boolean> {
        if (this.stopped) return false;
        if (!this.spawnedByUs) return false;
        this.deps.env = { ...this.deps.env, ...env };
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
        const old = this.child;
        // The exit handler reads this to tell a deliberate end from a crash.
        this.stopping = true;
        if (old) {
            this.log(`[${this.deps.name}] restarting`);
            await new Promise<void>((done) => {
                const force = setTimeout(() => {
                    old.kill("SIGKILL");
                    done();
                }, RESTART_KILL_MS);
                old.once("exit", () => {
                    clearTimeout(force);
                    done();
                });
                old.kill("SIGTERM");
            });
        }
        if (this.stopped) return false;
        this.child = null;
        this.stopping = false;
        this.restarts = 0;
        this.spawn();
        return this.child !== null;
    }

    /** Stop the child we spawned (no-op for an adopted service). */
    stop() {
        this.stopped = true;
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.child && this.spawnedByUs) {
            this.log(`[${this.deps.name}] stopping (app quit)`);
            this.child.kill("SIGTERM");
            this.child = null;
        }
    }
}
