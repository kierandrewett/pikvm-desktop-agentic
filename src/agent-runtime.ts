/**
 * Where the pikvm-agent runtime lives, and what to do when it does not exist.
 *
 * This used to be a list of guesses ending in the bare string "pikvm-agent",
 * handed to spawn() in the hope that PATH would sort it out. It did not fail —
 * that was the problem. A machine with no runtime installed got a spawn error
 * buried in a log, a dead conversation panel, and no statement anywhere that the
 * daemon had never started. The packaged RPM was in exactly that state on every
 * machine except the one it was built on, where an unrelated development
 * checkout happened to satisfy the last guess.
 *
 * So the rules here are:
 *
 *  - A candidate counts only when something is actually there. Never a bare name
 *    passed to spawn() and hoped over. There are two places the runtime can be —
 *    shipped with the app, or built in the checkout — plus an override for
 *    anywhere else. No PATH sweep, because nothing publishes this executable.
 *  - Finding nothing is a RESULT, not a fallback. Callers get `found: false`
 *    and a hint naming the fix, and are expected to say so out loud.
 *  - The daemon and the harness are the same installation. One ordered list,
 *    used by both. Two copies of a preference order is how they end up
 *    launching different builds the day one gains a candidate the other lacks.
 *
 * Pure and injectable on purpose: `exists` is a parameter, so the ordering can
 * be tested without a filesystem, which is what the old source-text regex
 * assertions in desktop-layout.test.ts were standing in for.
 */

import { posix, win32 } from "node:path";

/** Which candidate won, in the order they are tried. */
export type AgentRuntimeSource =
    /** An explicit setting or env var. The operator asked for this one by name. */
    | "override"
    /** Shipped inside the application. The normal answer for an installed app. */
    | "bundled"
    /** A development checkout's own virtualenv. The normal answer under `yarn start`. */
    | "workspace";

export interface AgentRuntimeFound {
    found: true;
    command: string;
    source: AgentRuntimeSource;
    /** Every path considered before this one, for logging a real explanation. */
    tried: string[];
}

export interface AgentRuntimeMissing {
    found: false;
    command: null;
    tried: string[];
    /** One line naming the fix, meant to reach a human unedited. */
    hint: string;
}

export type AgentRuntimeResolution = AgentRuntimeFound | AgentRuntimeMissing;

export interface AgentRuntimeLocations {
    /* Explicitly `| undefined` rather than plain optional: the project builds with
     * exactOptionalPropertyTypes, and every caller here forwards a settings value
     * or an env var that is genuinely sometimes undefined. */
    /** Explicit settings value, if the operator set one. */
    configured?: string | undefined;
    /** Env overrides, most specific first. Undefined entries are ignored. */
    env?: (string | undefined)[] | undefined;
    /** The runtime shipped with the application. */
    bundled: string;
    /** A development checkout's virtualenv. */
    workspace: string;
}

export interface AgentRuntimeProbes {
    exists: (path: string) => boolean;
}

/** The name the runtime installs itself as inside a venv's bin directory. */
export const AGENT_EXECUTABLE = "pikvm-agent";

/**
 * Where the runtime's executable sits under `agentDir` (the `agent/` folder, in the repo or beside the
 * app's resources), per platform.
 *
 * POSIX: `runtime/bin/pikvm-agent`, a shell launcher, and `.venv/bin/pikvm-agent` in a checkout.
 * Windows: `runtime\pikvm-agent.exe` beside python.exe (the standalone Windows layout has no bin/), and
 * `.venv\Scripts\pikvm-agent.exe` in a checkout. It has to be an exe: the app spawns it directly and
 * Node will not start a .cmd without a shell. Separators follow the platform, not the machine running this,
 * so the answer can be checked for either.
 */
export function agentExecutablePaths(
    agentDir: string,
    platform: NodeJS.Platform = process.platform,
): { bundled: string; workspace: string } {
    if (platform === "win32") {
        const exe = `${AGENT_EXECUTABLE}.exe`;
        return {
            bundled: win32.join(agentDir, "runtime", exe),
            workspace: win32.join(agentDir, ".venv", "Scripts", exe),
        };
    }
    return {
        bundled: posix.join(agentDir, "runtime", "bin", AGENT_EXECUTABLE),
        workspace: posix.join(agentDir, ".venv", "bin", AGENT_EXECUTABLE),
    };
}

const HINT =
    `No ${AGENT_EXECUTABLE} runtime found. Build the bundled one with ` +
    `\`make agent-runtime\`, or for a development checkout run ` +
    `\`uv venv agent/.venv && uv pip install -e agent\`.`;

/**
 * Resolve the runtime, in order, taking the first candidate that exists.
 *
 * Order is deliberate and short. An explicit override outranks everything
 * because the operator named it. Bundled outranks workspace so an installed app
 * never quietly runs a developer's half-migrated checkout. There is no third
 * place to look: the runtime is either shipped with the app or built in the
 * checkout, and anything else is what the override is for.
 */
export function resolveAgentRuntime(
    locations: AgentRuntimeLocations,
    probes: AgentRuntimeProbes,
): AgentRuntimeResolution {
    const ordered: { path: string; source: AgentRuntimeSource }[] = [];
    for (const o of [locations.configured, ...(locations.env ?? [])]) {
        if (o) ordered.push({ path: o, source: "override" });
    }
    ordered.push({ path: locations.bundled, source: "bundled" });
    ordered.push({ path: locations.workspace, source: "workspace" });

    const tried: string[] = [];
    for (const { path, source } of ordered) {
        tried.push(path);
        if (probes.exists(path)) return { found: true, command: path, source, tried };
    }
    return { found: false, command: null, tried, hint: HINT };
}

/** One line for a log: what was chosen, or what was tried and why it failed. */
export function describeAgentRuntime(r: AgentRuntimeResolution): string {
    if (r.found) return `[agent] runtime: ${r.command} (${r.source})`;
    return `[agent] runtime NOT FOUND. Tried: ${r.tried.join(", ")}. ${r.hint}`;
}
