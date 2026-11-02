/**
 * The PiKVM the agent drives is the one the app is set to, and no other.
 *
 * The machine-control daemon used to take its target from `~/.config/pikvm-agent/config.yaml`, so
 * the desktop app could show one PiKVM and the agent act on another (a stale file, a different
 * machine's config). The daemon already lets the environment decide (agent/pikvm_agent/config.py:
 * PIKVM_BASE_URL over the file, the user and password from their variables), so the app puts its
 * own target there when it starts the daemon.
 *
 * The password travels in the child's environment and nowhere else: never an argument (every
 * process can read those), never a log line (the service manager logs the command line only).
 */

import type { ResolvedTarget } from "./target-store";

/**
 * Every variable the daemon reads the target from, set whatever the desktop's own environment
 * holds: an empty value is "none", and an unset one would let a stray PIKVM_USER or PIKVM_TOKEN in
 * the shell that launched the app decide.
 */
export function agentTargetEnvironment(target: ResolvedTarget): NodeJS.ProcessEnv {
    return {
        PIKVM_BASE_URL: target.origin.replace(/\/+$/, ""),
        PIKVM_USER: target.username,
        PIKVM_PASSWORD: target.password,
        // An auth cookie from the environment would be someone else's session on someone else's target.
        PIKVM_TOKEN: "",
        // The Pi's certificate is self-signed; the app's own proxy does not verify it either.
        PIKVM_VERIFY_TLS: "0",
    };
}

/** Whether two targets would make the daemon connect differently. */
export function sameAgentTarget(a: ResolvedTarget, b: ResolvedTarget): boolean {
    return a.origin === b.origin && a.username === b.username && a.password === b.password;
}
