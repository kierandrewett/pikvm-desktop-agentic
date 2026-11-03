/**
 * Runtime options: the parts of config.yml that map Chat settings onto the runtime's own option keys.
 *
 * - model roles   `smol`, `slow`, `tiny` and `memory`, each resolved by models/roles.ts
 * - built-in tools a tool in `agent.disabledTools` is also switched off at its source (`<tool>.enabled: false`), so
 *                 the model is never offered it; the approval `deny` entry (config.ts) stays as the second guard
 * - compaction    `agent.compaction` -> `compaction.enabled` / `compaction.thresholdPercent`
 * - hosting       runtime features that must stay off whatever the settings say
 *
 * Every value here is derived from declared settings (packages/chat-protocol/src/settings.ts); nothing is read from
 * the environment or from files.
 */
import { runtimeModelRoles } from "../models/roles.ts";
import { setting } from "../settings/store.ts";

/**
 * Built-in tools whose source switch differs from the tool name, or that have one at all. Tools not listed here
 * (read, write, edit, task, ...) have no switch: the approval `deny` entry is the only way to turn them off.
 */
const TOOL_SWITCHES: Record<string, { key: string; off: boolean | string }> = {
    bash: { key: "bash", off: false },
    todo: { key: "todo", off: false },
    ask: { key: "ask", off: false },
    glob: { key: "glob", off: false },
    grep: { key: "grep", off: false },
    find: { key: "find", off: "off" },
    lsp: { key: "lsp", off: false },
    debug: { key: "debug", off: false },
    ida: { key: "ida", off: false },
    github: { key: "github", off: false },
    checkpoint: { key: "checkpoint", off: false },
    ast_grep: { key: "astGrep", off: false },
    ast_edit: { key: "astEdit", off: false },
    security_scan: { key: "security", off: false },
    web_search: { key: "web_search", off: false },
    fetch: { key: "fetch", off: false },
    browser: { key: "browser", off: false },
};

/**
 * Off on every host. `dev.autoqa` lets the model file tool-issue reports that are pushed to the runtime vendor's
 * collector after a consent dialog: user data would leave the instance.
 */
const HOSTING = { dev: { autoqa: false } };

export interface RuntimeOptions {
    /** Merged into config.yml. */
    config: Record<string, unknown>;
    /** Merged into config.yml `modelRoles`. */
    modelRoles: Record<string, string>;
}

/** Config entries that switch tools off at their source, for the tools that have a switch. */
export function toolSwitchesOff(names: Iterable<string>): Record<string, { enabled: boolean | string }> {
    const out: Record<string, { enabled: boolean | string }> = {};
    for (const name of names) {
        const sw = TOOL_SWITCHES[name];
        if (sw) out[sw.key] = { enabled: sw.off };
    }
    return out;
}

/** Every tool name and switch that toolSwitchesOff knows. */
export const SWITCHED_TOOLS = Object.keys(TOOL_SWITCHES);

export function runtimeOptions(userId: string): RuntimeOptions {
    const modelRoles = runtimeModelRoles(userId);
    const config: Record<string, unknown> = { ...HOSTING, ...toolSwitchesOff(setting("agent.disabledTools", userId)) };
    const compaction = setting("agent.compaction", userId);
    config.compaction = {
        enabled: compaction.enabled,
        ...(compaction.thresholdPercent > 0 ? { thresholdPercent: compaction.thresholdPercent } : {}),
    };
    return { config, modelRoles };
}
