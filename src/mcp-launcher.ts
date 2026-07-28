/**
 * Stable stdio entrypoint for ordinary MCP clients.
 *
 * PiKVM Desktop publishes a short-lived, owner-only managed-agent credential
 * only after its operator harness is healthy. Ordinary clients receive the
 * high-level computer task facade; guarded direct control is an explicit
 * compatibility mode.
 */

import { spawn } from "node:child_process";
import { readHarnessRuntime } from "./harness-runtime";
import {
    selectMcpLaunch,
    type ControlMode,
} from "./mcp-launch-plan";

interface LauncherOptions {
    runtimePath: string;
    callerLabel: string;
    controlMode: ControlMode;
}

function parseArgs(args: string[]): LauncherOptions {
    let runtimePath = "";
    let callerLabel = "claude-cli";
    let controlMode: ControlMode = "managed";
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--runtime") {
            runtimePath = args[++index] ?? "";
        } else if (arg === "--caller-label") {
            callerLabel = args[++index] ?? "";
        } else if (arg === "--control-mode") {
            const value = args[++index] ?? "";
            if (value !== "managed" && value !== "direct") {
                throw new Error("--control-mode must be managed or direct");
            }
            controlMode = value;
        } else {
            throw new Error(`unknown argument: ${arg ?? ""}`);
        }
    }
    if (!runtimePath) throw new Error("--runtime is required");
    return { runtimePath, callerLabel, controlMode };
}

export function launchMcp(args = process.argv.slice(2)): void {
    let options: LauncherOptions;
    try {
        options = parseArgs(args);
        const runtime = readHarnessRuntime(options.runtimePath);
        const launch = selectMcpLaunch(
            runtime,
            options.callerLabel,
            options.controlMode,
        );
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
                `PiKVM Desktop MCP unavailable: could not start ${options.controlMode} MCP (${String(error)})`,
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
