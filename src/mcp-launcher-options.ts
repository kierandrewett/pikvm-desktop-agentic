import type { ControlMode } from "./mcp-launch-plan";

export interface LauncherOptions {
    runtimePath: string;
    callerLabel: string;
    controlMode: ControlMode;
}

export function parseMcpLauncherArgs(args: string[]): LauncherOptions {
    let runtimePath = "";
    let callerLabel = "";
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
    if (!callerLabel.trim()) throw new Error("--caller-label is required");
    return { runtimePath, callerLabel, controlMode };
}
