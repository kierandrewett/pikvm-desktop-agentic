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
    parseMcpLauncherArgs,
    type LauncherOptions,
} from "./mcp-launcher-options";
import { selectMcpLaunch } from "./mcp-launch-plan";

export function launchMcp(args = process.argv.slice(2)): void {
    let options: LauncherOptions;
    try {
        options = parseMcpLauncherArgs(args);
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
