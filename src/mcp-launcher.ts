/**
 * Stable stdio entrypoint for ordinary MCP clients.
 *
 * PiKVM Desktop writes the short-lived observer credential only after its
 * operator harness is healthy. This launcher validates that handoff and then
 * execs the guarded, visible direct-MCP boundary.
 */

import { spawn } from "node:child_process";
import {
    buildDirectMcpLaunch,
    readHarnessRuntime,
} from "./harness-runtime";

interface LauncherOptions {
    runtimePath: string;
    callerLabel: string;
}

function parseArgs(args: string[]): LauncherOptions {
    let runtimePath = "";
    let callerLabel = "claude-cli";
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--runtime") {
            runtimePath = args[++index] ?? "";
        } else if (arg === "--caller-label") {
            callerLabel = args[++index] ?? "";
        } else {
            throw new Error(`unknown argument: ${arg ?? ""}`);
        }
    }
    if (!runtimePath) throw new Error("--runtime is required");
    return { runtimePath, callerLabel };
}

export function launchMcp(args = process.argv.slice(2)): void {
    let options: LauncherOptions;
    try {
        options = parseArgs(args);
        const runtime = readHarnessRuntime(options.runtimePath);
        const launch = buildDirectMcpLaunch(runtime, options.callerLabel);
        const child = spawn(launch.command, launch.args, {
            env: launch.env,
            stdio: "inherit",
        });
        const forward = (signal: NodeJS.Signals) => {
            if (!child.killed) child.kill(signal);
        };
        process.once("SIGINT", forward);
        process.once("SIGTERM", forward);
        child.once("error", (error) => {
            console.error(
                `PiKVM Desktop MCP unavailable: could not start guarded MCP (${String(error)})`,
            );
            process.exitCode = 2;
        });
        child.once("exit", (code, signal) => {
            process.removeListener("SIGINT", forward);
            process.removeListener("SIGTERM", forward);
            if (signal) {
                process.kill(process.pid, signal);
                return;
            }
            process.exitCode = code ?? 2;
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`PiKVM Desktop MCP unavailable: ${message}`);
        process.exitCode = 2;
    }
}

if (require.main === module) launchMcp();
