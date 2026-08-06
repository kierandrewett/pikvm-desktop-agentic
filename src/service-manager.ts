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
}

const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 5; // within a session — beyond this we give up (likely misconfigured)

export type ManagedServiceStart = "started" | "adopted" | "conflict";

export class ManagedService {
    private child: ChildProcess | null = null;
    private spawnedByUs = false;
    private stopping = false;
    private restarts = 0;
    private restartTimer: NodeJS.Timeout | null = null;

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
        let child: ChildProcess;
        try {
            child = spawn(command, args, {
                cwd,
                env: { ...process.env, ...env },
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
            if (this.restarts >= MAX_RESTARTS) {
                this.log(
                    `[${this.deps.name}] giving up after ${MAX_RESTARTS} restarts — check its config/command`,
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

    /** Stop the child we spawned (no-op for an adopted service). */
    stop() {
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.child && this.spawnedByUs) {
            this.log(`[${this.deps.name}] stopping (app quit)`);
            this.child.kill("SIGTERM");
            this.child = null;
        }
    }
}
