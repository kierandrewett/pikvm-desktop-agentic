import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isUnixEndpointValue, parseEndpoint } from "./endpoint";

const TOKEN_MIN_LENGTH = 32;
const MAX_RUNTIME_BYTES = 64 * 1024;
const CALLER_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_MANAGED_RUNTIME_ENV = "PIKVM_MANAGED_CLIENT_RUNTIME";
const MANAGED_AGENT_TOKEN_ENV = "PIKVM_HARNESS_AGENT_TOKEN";
const MANAGED_RUNTIME_NAME = "managed-client-runtime.json";
/**
 * How an MCP child is told where the running harness actually is.
 *
 * The child loads the same harness YAML we do, and that file's `listen` is only
 * where the harness would bind by DEFAULT. We move it — to a free port when the
 * configured one is taken, and now onto a unix socket — without rewriting a
 * file that carries the operator's provider settings. A child left to infer the
 * address from the YAML therefore sends every managed and direct MCP call at an
 * address nothing is listening on. This is the desktop saying where it put it.
 */
const HARNESS_ENDPOINT_ENV = "PIKVM_HARNESS_ENDPOINT";

export interface HarnessRuntime {
    version: 3;
    desktopPid: number;
    harnessOrigin: string;
    daemonOrigin: string;
    harnessExecutable: string;
    harnessConfig: string;
    agentToken: string;
    daemonActionToken: string;
    observerToken: string;
}

export interface HarnessRuntimeReadOptions {
    requireLiveDesktop?: boolean;
}

export interface McpLaunch {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

interface ManagedClientRuntime {
    schema_version: 1;
    harness_config: string;
    agent_token_env: typeof MANAGED_AGENT_TOKEN_ENV;
    agent_token: string;
}

const SCOPED_CAPABILITY_ENV = [
    "PIKVM_AGENT_DAEMON_TOKEN",
    "PIKVM_AGENT_HARNESS_TOKEN",
    "PIKVM_HARNESS_TOKEN",
    "PIKVM_HARNESS_AGENT_TOKEN",
    "PIKVM_HARNESS_OBSERVER_TOKEN",
] as const;

function withoutScopedCapabilities(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const name of SCOPED_CAPABILITY_ENV) delete environment[name];
    return environment;
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

/**
 * Where a local service is, as recorded in the handoff file.
 *
 * This file is read by processes that are not this one — dist/mcp-launcher.js
 * runs as a child of whatever MCP client the user configured — so what it
 * accepts is the contract, and both transports have to be in it. A unix
 * endpoint is at least as local as a loopback port: a socket path names one
 * service on this machine and cannot be reached from anywhere else at all.
 * Anything else is still refused, so a runtime file pointing at a remote host
 * cannot turn an MCP client into a proxy for someone else's computer.
 */
function requireLocalEndpoint(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`${field} is missing`);
    if (isUnixEndpointValue(value)) {
        let endpoint;
        try {
            endpoint = parseEndpoint(value);
        } catch {
            throw new Error(`${field} must name an absolute socket path`);
        }
        // Relative resolves against whatever working directory the MCP client
        // happened to have, which is not a selection of anything.
        if (endpoint.kind !== "unix" || !isAbsolute(endpoint.socketPath)) {
            throw new Error(`${field} must name an absolute socket path`);
        }
        return endpoint.value;
    }
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
        throw new Error(`${field} must use loopback HTTP or a unix socket`);
    }
    return url.toString().replace(/\/$/, "");
}

function validateRuntime(value: unknown): HarnessRuntime {
    if (!value || typeof value !== "object") {
        throw new Error("harness runtime must be an object");
    }
    const raw = value as Record<string, unknown>;
    if (raw.version === 1 || raw.version === 2) {
        throw new Error(
            "restart PiKVM Desktop to enable managed MCP; this runtime was created by an older desktop build",
        );
    }
    if (raw.version !== 3) throw new Error("unsupported harness runtime version");
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
        typeof raw.agentToken !== "string" ||
        raw.agentToken.length < TOKEN_MIN_LENGTH
    ) {
        throw new Error("agentToken is missing or too short");
    }
    if (
        typeof raw.daemonActionToken !== "string" ||
        raw.daemonActionToken.length < TOKEN_MIN_LENGTH
    ) {
        throw new Error("daemonActionToken is missing or too short");
    }
    if (
        typeof raw.observerToken !== "string" ||
        raw.observerToken.length < TOKEN_MIN_LENGTH
    ) {
        throw new Error("observerToken is missing or too short");
    }
    return {
        version: 3,
        desktopPid: raw.desktopPid,
        harnessOrigin: requireLocalEndpoint(raw.harnessOrigin, "harnessOrigin"),
        daemonOrigin: requireLocalEndpoint(raw.daemonOrigin, "daemonOrigin"),
        harnessExecutable: raw.harnessExecutable,
        harnessConfig: raw.harnessConfig,
        agentToken: raw.agentToken,
        daemonActionToken: raw.daemonActionToken,
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

export function activeManagedClientRuntimePath(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    const configured = environment[ACTIVE_MANAGED_RUNTIME_ENV]?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error(
                `${ACTIVE_MANAGED_RUNTIME_ENV} must be an absolute path`,
            );
        }
        return configured;
    }
    const xdgRuntime = environment.XDG_RUNTIME_DIR?.trim();
    if (xdgRuntime) {
        if (!isAbsolute(xdgRuntime)) {
            throw new Error("XDG_RUNTIME_DIR must be an absolute path");
        }
        return join(
            xdgRuntime,
            "pikvm-agent",
            "managed",
            MANAGED_RUNTIME_NAME,
        );
    }
    if (process.platform === "win32") {
        const localAppData = environment.LOCALAPPDATA?.trim();
        if (!localAppData || !isAbsolute(localAppData)) {
            throw new Error(
                "LOCALAPPDATA must be an absolute path for managed MCP",
            );
        }
        return join(localAppData, "PiKVM Agent", MANAGED_RUNTIME_NAME);
    }
    const uid =
        typeof process.getuid === "function" ? process.getuid() : process.pid;
    return join(tmpdir(), `pikvm-agent-${uid}`, MANAGED_RUNTIME_NAME);
}

function ensurePrivateParent(path: string): void {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(
            "managed client runtime parent must be a real directory",
        );
    }
    if (process.platform !== "win32") {
        if ((metadata.mode & 0o077) !== 0) {
            throw new Error(
                "managed client runtime parent must be owner-only",
            );
        }
        if (
            typeof process.getuid === "function" &&
            metadata.uid !== process.getuid()
        ) {
            throw new Error(
                "managed client runtime parent is owned by another user",
            );
        }
    }
}

function managedClientRuntime(runtime: HarnessRuntime): ManagedClientRuntime {
    const validated = validateRuntime(runtime);
    return {
        schema_version: 1,
        harness_config: validated.harnessConfig,
        agent_token_env: MANAGED_AGENT_TOKEN_ENV,
        agent_token: validated.agentToken,
    };
}

export function writeManagedClientRuntime(
    path: string,
    runtime: HarnessRuntime,
): void {
    if (!isAbsolute(path)) {
        throw new Error("managed client runtime path must be absolute");
    }
    ensurePrivateParent(path);
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`,
    );
    try {
        writeFileSync(
            temporary,
            `${JSON.stringify(managedClientRuntime(runtime), null, 2)}\n`,
            {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            },
        );
        if (process.platform !== "win32") chmodSync(temporary, 0o600);
        renameSync(temporary, path);
        if (process.platform !== "win32") chmodSync(path, 0o600);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

export function removeManagedClientRuntime(
    path: string,
    expectedAgentToken: string,
): boolean {
    try {
        const metadata = statSync(path);
        if (!metadata.isFile() || metadata.size > MAX_RUNTIME_BYTES) {
            return false;
        }
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (
            !value ||
            typeof value !== "object" ||
            (value as Record<string, unknown>).schema_version !== 1 ||
            (value as Record<string, unknown>).agent_token !==
                expectedAgentToken
        ) {
            return false;
        }
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
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
): McpLaunch {
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
            ...withoutScopedCapabilities(),
            PIKVM_AGENT_DAEMON: validated.daemonOrigin,
            PIKVM_AGENT_DAEMON_TOKEN: validated.daemonActionToken,
            [HARNESS_ENDPOINT_ENV]: validated.harnessOrigin,
            PIKVM_HARNESS_OBSERVER_TOKEN: validated.observerToken,
        },
    };
}

export function buildManagedMcpLaunch(
    runtime: HarnessRuntime,
    callerLabel: string,
): McpLaunch {
    const validated = validateRuntime(runtime);
    if (!CALLER_LABEL.test(callerLabel)) {
        throw new Error("caller label contains unsupported characters");
    }
    return {
        command: validated.harnessExecutable,
        args: [
            "harness",
            "managed-mcp",
            "--config",
            validated.harnessConfig,
            "--caller-label",
            callerLabel,
        ],
        env: {
            ...withoutScopedCapabilities(),
            [HARNESS_ENDPOINT_ENV]: validated.harnessOrigin,
            PIKVM_HARNESS_AGENT_TOKEN: validated.agentToken,
        },
    };
}
