import {
    chmodSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

const TOKEN_MIN_LENGTH = 32;
const MAX_RUNTIME_BYTES = 64 * 1024;
const CALLER_LABEL = /^[A-Za-z0-9_-]{1,64}$/;

export interface HarnessRuntime {
    version: 1;
    desktopPid: number;
    harnessOrigin: string;
    daemonOrigin: string;
    harnessExecutable: string;
    harnessConfig: string;
    observerToken: string;
}

export interface HarnessRuntimeReadOptions {
    requireLiveDesktop?: boolean;
}

export interface DirectMcpLaunch {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

export function withHarnessAuthorization(
    headers: Record<string, string>,
    token: string,
): Record<string, string> {
    const replaced = Object.fromEntries(
        Object.entries(headers).filter(
            ([name]) => name.toLowerCase() !== "authorization",
        ),
    );
    replaced.Authorization = `Bearer ${token}`;
    return replaced;
}

function requireLoopbackOrigin(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`${field} is missing`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${field} must be a URL`);
    }
    if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
        throw new Error(`${field} must use loopback HTTP`);
    }
    return url.toString().replace(/\/$/, "");
}

function validateRuntime(value: unknown): HarnessRuntime {
    if (!value || typeof value !== "object") {
        throw new Error("harness runtime must be an object");
    }
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1) throw new Error("unsupported harness runtime version");
    if (
        typeof raw.desktopPid !== "number" ||
        !Number.isSafeInteger(raw.desktopPid) ||
        raw.desktopPid < 1
    ) {
        throw new Error("desktopPid must be a positive integer");
    }
    if (
        typeof raw.harnessExecutable !== "string" ||
        !raw.harnessExecutable.trim()
    ) {
        throw new Error("harnessExecutable is missing");
    }
    if (
        typeof raw.harnessConfig !== "string" ||
        !isAbsolute(raw.harnessConfig)
    ) {
        throw new Error("harnessConfig must be an absolute path");
    }
    if (
        typeof raw.observerToken !== "string" ||
        raw.observerToken.length < TOKEN_MIN_LENGTH
    ) {
        throw new Error("observerToken is missing or too short");
    }
    return {
        version: 1,
        desktopPid: raw.desktopPid,
        harnessOrigin: requireLoopbackOrigin(
            raw.harnessOrigin,
            "harnessOrigin",
        ),
        daemonOrigin: requireLoopbackOrigin(raw.daemonOrigin, "daemonOrigin"),
        harnessExecutable: raw.harnessExecutable,
        harnessConfig: raw.harnessConfig,
        observerToken: raw.observerToken,
    };
}

export function writeHarnessRuntime(path: string, runtime: HarnessRuntime): void {
    const validated = validateRuntime(runtime);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function readHarnessRuntime(
    path: string,
    options: HarnessRuntimeReadOptions = {},
): HarnessRuntime & { mode: number } {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_RUNTIME_BYTES) {
        throw new Error("harness runtime is not a small regular file");
    }
    if (process.platform !== "win32") {
        if ((stat.mode & 0o077) !== 0) {
            throw new Error("harness runtime must be owner-only");
        }
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
            throw new Error("harness runtime is owned by another user");
        }
    }
    const runtime = validateRuntime(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (options.requireLiveDesktop !== false) {
        try {
            process.kill(runtime.desktopPid, 0);
        } catch {
            throw new Error(
                "PiKVM Desktop is not running; open it before reconnecting the MCP server",
            );
        }
    }
    return { ...runtime, mode: stat.mode };
}

export function buildDirectMcpLaunch(
    runtime: HarnessRuntime,
    callerLabel: string,
): DirectMcpLaunch {
    const validated = validateRuntime(runtime);
    if (!CALLER_LABEL.test(callerLabel)) {
        throw new Error("caller label contains unsupported characters");
    }
    return {
        command: validated.harnessExecutable,
        args: [
            "harness",
            "direct-mcp",
            "--config",
            validated.harnessConfig,
            "--mode",
            "guarded",
            "--caller-label",
            callerLabel,
        ],
        env: {
            ...process.env,
            PIKVM_AGENT_DAEMON: validated.daemonOrigin,
            PIKVM_AGENT_TRUSTED_APPROVAL_CLIENT: "0",
            PIKVM_HARNESS_OBSERVER_TOKEN: validated.observerToken,
        },
    };
}
