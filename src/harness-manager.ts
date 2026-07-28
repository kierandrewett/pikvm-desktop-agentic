/** Desktop-owned lifecycle and credential boundary for the operator harness. */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import {
    ManagedService,
    type ManagedServiceStart,
} from "./service-manager";
import { writeHarnessRuntime } from "./harness-runtime";

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
    runtimePath: string;
    cwd: string;
    log?: (line: string) => void;
    runInit?: InitRunner;
    service?: ManagedService;
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
                args: ["harness", "serve", "--config", deps.configPath],
                cwd: deps.cwd,
                env: {
                    PIKVM_AGENT_DAEMON: deps.daemonOrigin,
                    PIKVM_AGENT_DAEMON_TOKEN: this.daemonActionToken,
                    PIKVM_AGENT_HARNESS_TOKEN: this.daemonHarnessToken,
                    PIKVM_HARNESS_TOKEN: this.accessToken,
                    PIKVM_HARNESS_AGENT_TOKEN: this.agentToken,
                    PIKVM_HARNESS_OBSERVER_TOKEN: this.observerToken,
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
        const origin = new URL(this.deps.origin);
        const listenHost =
            origin.hostname === "[::1]" ? "::1" : origin.hostname;
        await this.runInit(
            this.deps.command,
            [
                "harness",
                "init",
                "--out",
                this.deps.configPath,
                "--oauth-clis",
                "auto",
                "--listen",
                `${listenHost}:${origin.port}`,
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
        writeHarnessRuntime(this.deps.runtimePath, {
            version: 3,
            desktopPid: process.pid,
            harnessOrigin: this.deps.origin,
            daemonOrigin: this.deps.daemonOrigin,
            harnessExecutable: this.deps.command,
            harnessConfig: this.deps.configPath,
            agentToken: this.agentToken,
            daemonActionToken: this.daemonActionToken,
            observerToken: this.observerToken,
        });
        this.log(
            "ready; managed Claude MCP compatibility is available (direct mode is explicit)",
        );
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.removeRuntime();
        this.service.stop();
    }
}
