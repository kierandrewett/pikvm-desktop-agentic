import {
    buildDirectMcpLaunch,
    buildManagedMcpLaunch,
    type HarnessRuntime,
    type McpLaunch,
} from "./harness-runtime";

export type ControlMode = "managed" | "direct";

export function selectMcpLaunch(
    runtime: HarnessRuntime,
    callerLabel: string,
    controlMode: ControlMode = "managed",
): McpLaunch {
    return controlMode === "direct"
        ? buildDirectMcpLaunch(runtime, callerLabel)
        : buildManagedMcpLaunch(runtime, callerLabel);
}
