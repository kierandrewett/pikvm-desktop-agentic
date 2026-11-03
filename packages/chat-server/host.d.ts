/**
 * What the host process sees of this package. The host's own TypeScript settings are stricter than the lifted code
 * was written for (`exactOptionalPropertyTypes`), so the host resolves `@pikvm/chat-server` to this file and never
 * type-checks the server's internals. `test/host-types.ts` checks, under this package's own settings, that
 * `src/index.ts` satisfies it, so the two cannot drift.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type ApprovalDecision = "approved" | "denied" | "unavailable";

export interface BuiltinMcpContext {
    userId: string;
    /** From `X-Chat-Conversation`; absent when the agent did not send it. */
    conversationId: string | undefined;
}

export interface BuiltinMcp {
    name: string;
    tools: readonly string[];
    handle(req: Request, ctx: BuiltinMcpContext): Promise<Response>;
}

export interface RunHooks {
    beginRun(conversationId: string): void;
    endRun(conversationId: string): void;
}

export interface ChatServerOptions {
    dataDir: string;
    apiPath?: string;
    settingsPath?: string;
    publicUrl?: string;
    migrationsDir?: string;
    resourcesDir?: string;
    instructions?: string;
    mcp?: readonly BuiltinMcp[];
    runs?: RunHooks;
    agentSurface?: { host?: string; port?: number };
    refreshCatalog?: boolean;
}

export interface ChatServerStatus {
    ready: boolean;
    runtime: { found: boolean; binary?: string; reason?: string };
    profile: "computer";
    agentSurface: string;
}

export interface ChatServer {
    handleRest(req: Request): Promise<Response>;
    handleNode(req: IncomingMessage, res: ServerResponse): Promise<void>;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    askApproval(
        server: string,
        ask: {
            conversationId: string | undefined;
            tool: string;
            title: string;
            summary: string;
            reasons: readonly string[];
            arguments: Readonly<Record<string, unknown>>;
            signal?: AbortSignal;
        },
    ): Promise<ApprovalDecision>;
    stopResponses(): number;
    /** The effective value of a setting the host reads. */
    setting(key: "agent.pikvm.approval"): "risky" | "always" | "never";
    setting(key: "agent.pikvm.allowPower"): boolean;
    setting(key: "agent.pikvm.maxEdge"): number;
    status(): ChatServerStatus;
    stop(): Promise<void>;
}

export function createChatServer(options: ChatServerOptions): Promise<ChatServer>;
