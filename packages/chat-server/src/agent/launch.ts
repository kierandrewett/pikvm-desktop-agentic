/**
 * Builds the command that runs the agent runtime.
 *
 * The runtime is omp's standalone binary. There is no sandbox in this build: the agent runs the `computer` profile
 * (config.ts), which leaves it no tool that reads files, runs commands or makes requests, and it gets a private HOME,
 * an empty working directory and a minimal environment. A sandboxed profile can be added behind `system.agent.profile`.
 *
 * The environment is built from nothing, never from the host's, so a provider key, a PiKVM password or a token in the
 * host process cannot reach the agent by inheritance.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { paths } from "../paths.ts";
import { setting } from "../settings/store.ts";

export class RuntimeError extends Error {}

export interface SpawnSpec {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
}

/** Where a packaged host keeps the binary (`<resources>/omp/omp[.exe]`), set by the host at start. */
let resourcesDir: string | undefined;

export function setResourcesDir(dir: string | undefined): void {
    resourcesDir = dir;
}

const EXE = process.platform === "win32" ? ".exe" : "";

function isExecutable(file: string): boolean {
    try {
        if (!statSync(file).isFile()) return false;
        accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** A PATH search that honours PATHEXT on Windows. */
export function which(name: string, pathVar = process.env.PATH ?? ""): string | undefined {
    const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
    for (const dir of pathVar.split(delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const file = join(dir, name + ext);
            if (isExecutable(file)) return file;
        }
    }
    return undefined;
}

/**
 * The agent binary: `OMP_BIN`, else `<resources>/omp/omp`, else the `system.agent.binary` setting (a path, or a
 * name looked up on PATH).
 */
export function locateRuntime(): string {
    const configured = setting("system.agent.binary");
    const fromEnv = process.env.OMP_BIN;
    const packaged = resourcesDir ? join(resourcesDir, "omp", `omp${EXE}`) : undefined;
    const found =
        (fromEnv && (isAbsolute(fromEnv) ? fromEnv : which(fromEnv))) ||
        (packaged && existsSync(packaged) ? packaged : undefined) ||
        (isAbsolute(configured) ? configured : which(configured));
    if (!found || !isExecutable(found)) {
        throw new RuntimeError(
            `The agent runtime was not found. Set OMP_BIN, or put omp on PATH (looked for "${fromEnv ?? configured}").`,
        );
    }
    return found;
}

/** The agent's PATH holds only system directories, never the host's. */
const SYSTEM_PATH = process.platform === "win32" ? "" : ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);

const BASE_ENV: Record<string, string> = {
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    OMP_SKIP_SETUP: "1",
    PI_NOTIFICATIONS: "0",
};

/**
 * @param cwd working directory, created by the caller
 * @param args runtime CLI arguments, after the generated `--config`
 * @param extraEnv extra environment (for example CHAT_CONVERSATION_ID, read by mcp.json header expansion)
 */
export function buildSpawn(userId: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}): SpawnSpec {
    const u = paths.user(userId);
    const binary = locateRuntime();
    // The generated config.yml is passed as the first `--config` overlay. Overlays merge above the project layer, so
    // every generated key holds whatever the working directory contains; later overlays in `args` still win.
    const env: Record<string, string> = { ...BASE_ENV, ...extraEnv, HOME: u.home, PATH: SYSTEM_PATH };
    if (process.platform === "win32") {
        // Windows will not start a process without these; they hold no secret.
        for (const key of ["SystemRoot", "TEMP", "TMP"] as const) {
            const value = process.env[key];
            if (value) env[key] = value;
        }
        env.USERPROFILE = u.home;
    }
    return { argv: [binary, "--config", u.ompConfig, ...args], env, cwd };
}

/** The runtime binary's state, for the status the host shows. Never throws. */
export function runtimeStatus(): { found: boolean; binary?: string; reason?: string } {
    try {
        return { found: true, binary: locateRuntime() };
    } catch (err) {
        return { found: false, reason: (err as Error).message };
    }
}
