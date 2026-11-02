/** Desktop-owned lifecycle and credential boundary for the operator harness. */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { parseEndpoint, type Endpoint } from "./endpoint";
import {
    ManagedService,
    type ManagedServiceStart,
} from "./service-manager";
import {
    removeManagedClientRuntime,
    writeHarnessRuntime,
    writeManagedClientRuntime,
} from "./harness-runtime";

const execFileAsync = promisify(execFile);

type InitRunner = (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<unknown>;

export interface HarnessManagerDeps {
    origin: string;
    daemonOrigin: string;
    command: string;
    configPath: string;
    /** The origins the app's own pages are served from (the control server's address). The harness
     *  refuses a browser request whose Origin it does not list, and every request the page makes
     *  through the desktop's proxy carries the page's origin. */
    uiOrigins?: readonly string[];
    runtimePath: string;
    managedClientRuntimePath: string;
    cwd: string;
    log?: (line: string) => void;
    runInit?: InitRunner;
    service?: ManagedService;
}

export function harnessDaemonSelectorEnvironment(
    daemonOrigin: string,
): NodeJS.ProcessEnv {
    return {
        PIKVM_AGENT_DAEMON: daemonOrigin,
        PIKVM_LAB_DAEMON_URL: daemonOrigin,
    };
}

/**
 * The origins the app's pages are served from, for the harness's allow-list. The window loads the
 * control server on loopback, so that is always listed (by address and by name); when the server is
 * bound to a LAN address a phone on it loads the app from there, so that is listed too. A wildcard
 * bind (0.0.0.0, ::) is no origin anyone can type, so it adds nothing.
 */
export function uiOriginsFor(bindHost: string, port: number): string[] {
    const hosts = ["127.0.0.1", "localhost"];
    const bound = bindHost.replace(/^\[|\]$/g, "");
    if (bound && !["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"].includes(bound)) {
        hosts.push(bound.includes(":") ? `[${bound}]` : bound);
    }
    return hosts.map((host) => `http://${host}:${port}`);
}

/** host:port for `harness serve --listen`, from the origin we intend to use.
 *  IPv6 loopback keeps its bare form, matching what ensureConfig() writes. */
function listenAddress(origin: string): string {
    const url = new URL(origin);
    const host = url.hostname === "[::1]" ? "::1" : url.hostname;
    return `${host}:${url.port}`;
}

/* Where THIS run's harness listens, as the child's own arguments.
 *
 * Two forms, one decision, made here rather than in the config file: --uds for
 * a socket we own, --listen for a port. Both are one run's bind and neither
 * rewrites the YAML, which carries the operator's provider settings.
 *
 * ensureConfig() writes the config's listen address only when the file does not
 * already exist, so on any install that has run once that port is fixed.
 * Without an override the app could pick a free origin and the child would
 * still charge at the old one — exactly the "[Errno 98] address already in use"
 * crash loop the daemon had before it was told its port. */
export function bindArguments(endpoint: Endpoint): string[] {
    return endpoint.kind === "unix"
        ? ["--uds", endpoint.socketPath]
        : ["--listen", listenAddress(endpoint.value)];
}

export class HarnessManager {
    readonly accessToken = randomBytes(32).toString("base64url");
    readonly agentToken = randomBytes(32).toString("base64url");
    readonly observerToken = randomBytes(32).toString("base64url");
    readonly daemonActionToken = randomBytes(32).toString("base64url");
    readonly daemonHarnessToken = randomBytes(32).toString("base64url");
    private readonly service: ManagedService;
    private readonly runInit: InitRunner;
    private stopped = false;

    constructor(private readonly deps: HarnessManagerDeps) {
        this.runInit =
            deps.runInit ??
            ((command, args, options) =>
                execFileAsync(command, args, {
                    cwd: options.cwd,
                    env: options.env,
                }));
        this.service =
            deps.service ??
            new ManagedService({
                name: "harness",
                origin: deps.origin,
                healthPath: "/api/health",
                command: deps.command,
                args: [
                    "harness",
                    "serve",
                    "--config",
                    deps.configPath,
                    ...bindArguments(parseEndpoint(deps.origin)),
                ],
                cwd: deps.cwd,
                env: {
                    ...harnessDaemonSelectorEnvironment(deps.daemonOrigin),
                    PIKVM_AGENT_DAEMON_TOKEN: this.daemonActionToken,
                    PIKVM_AGENT_HARNESS_TOKEN: this.daemonHarnessToken,
                    PIKVM_HARNESS_TOKEN: this.accessToken,
                    PIKVM_HARNESS_AGENT_TOKEN: this.agentToken,
                    PIKVM_HARNESS_OBSERVER_TOKEN: this.observerToken,
                    ...(deps.uiOrigins && deps.uiOrigins.length > 0
                        ? { PIKVM_HARNESS_ALLOWED_ORIGINS: deps.uiOrigins.join(",") }
                        : {}),
                },
                adoptExisting: false,
                ...(deps.log ? { log: deps.log } : {}),
            });
    }

    get origin(): string {
        return this.deps.origin;
    }

    get runtimePath(): string {
        return this.deps.runtimePath;
    }

    get configPath(): string {
        return this.deps.configPath;
    }

    private log(line: string): void {
        this.deps.log?.(`[harness] ${line}`);
    }

    private async ensureConfig(): Promise<void> {
        if (existsSync(this.deps.configPath)) return;
        this.log("creating secret-free BYO-provider config");
        /* A socket has no host:port to seed the config with, and it does not
         * need one: `harness serve --uds` never reads that field to bind. What
         * still reads it is the workspace's cross-origin allowlist, so the
         * generated default (loopback 47616) is left in place rather than
         * emptied — the harness is reached through the desktop's own proxy, and
         * an allowlist of nothing would refuse every request it receives. */
        const endpoint = parseEndpoint(this.deps.origin);
        await this.runInit(
            this.deps.command,
            [
                "harness",
                "init",
                "--out",
                this.deps.configPath,
                "--oauth-clis",
                "auto",
                ...(endpoint.kind === "unix"
                    ? []
                    : ["--listen", listenAddress(endpoint.value)]),
            ],
            { cwd: this.deps.cwd, env: process.env },
        );
        if (!existsSync(this.deps.configPath)) {
            throw new Error("harness init completed without creating its config");
        }
    }

    private removeRuntime(): void {
        try {
            if (existsSync(this.deps.runtimePath)) {
                unlinkSync(this.deps.runtimePath);
            }
        } catch (error) {
            this.log(`could not remove stale MCP runtime handoff: ${String(error)}`);
        }
        if (
            !removeManagedClientRuntime(
                this.deps.managedClientRuntimePath,
                this.agentToken,
            ) &&
            existsSync(this.deps.managedClientRuntimePath)
        ) {
            this.log(
                "left active managed runtime owned by another desktop instance",
            );
        }
    }

    async start(): Promise<void> {
        if (this.stopped) throw new Error("harness manager is stopped");
        await this.ensureConfig();
        const outcome: ManagedServiceStart = await this.service.start();
        if (outcome === "conflict") {
            this.removeRuntime();
            throw new Error(
                `another credential-bound harness already owns ${this.deps.origin}`,
            );
        }
        if (!(await this.service.waitUntilHealthy())) {
            this.service.stop();
            this.removeRuntime();
            throw new Error(
                `operator harness did not become healthy at ${this.deps.origin}`,
            );
        }
        const runtime = {
            version: 3,
            desktopPid: process.pid,
            harnessOrigin: this.deps.origin,
            daemonOrigin: this.deps.daemonOrigin,
            harnessExecutable: this.deps.command,
            harnessConfig: this.deps.configPath,
            agentToken: this.agentToken,
            daemonActionToken: this.daemonActionToken,
            observerToken: this.observerToken,
        } as const;
        try {
            writeHarnessRuntime(this.deps.runtimePath, runtime);
            writeManagedClientRuntime(
                this.deps.managedClientRuntimePath,
                runtime,
            );
        } catch (error) {
            this.removeRuntime();
            this.service.stop();
            throw error;
        }
        this.log(
            "ready; managed MCP compatibility is active for supported clients (direct mode is explicit)",
        );
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.removeRuntime();
        this.service.stop();
    }
}
