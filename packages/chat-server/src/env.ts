/** Set CHAT_AGENT_DEBUG to print the agent runtime's stderr. */
export const env = {
    agentDebug: !!process.env.CHAT_AGENT_DEBUG,
} as const;

let baseUrl = "";

/** Where the agent reaches the agent surface. Set once the surface listens (`createChatServer`). */
export function setAgentBaseUrl(url: string): void {
    baseUrl = url;
}

export function agentBaseUrl(): string {
    if (!baseUrl) throw new Error("[env] the agent surface is not listening yet");
    return baseUrl;
}

let instructions = "";

/** What the host tells the agent about its tools (the PiKVM computer-use guidance), appended to the system prompt. */
export function setHostInstructions(text: string): void {
    instructions = text.trim();
}

export function hostInstructions(): string {
    return instructions;
}

/** Product name sent to OAuth servers and shown on their consent pages. */
export const INSTANCE_NAME = "PiKVM";

let publicBase = "";

/**
 * The address the browser reaches the app at, when the host knows it (`https://kvm.example.org/app/chat`). OAuth
 * for remote MCP servers needs it for the redirect; without it only servers that register clients dynamically work
 * over plain HTTP loopback.
 */
export function setPublicUrl(url: string): void {
    publicBase = url.replace(/\/+$/, "");
}

export function publicUrl(): string {
    return publicBase;
}

let paths = { api: "/api", settings: "/settings/mcp" };

/** Where the browser reaches this server's REST routes and the MCP settings page, for redirects. */
export function setHostPaths(next: { api: string; settings: string }): void {
    paths = next;
}

export function hostPaths(): { api: string; settings: string } {
    return paths;
}

export interface RunHooks {
    /** A response started from a user message. */
    beginRun(conversationId: string): void;
    /** A response ended: finished, failed, stopped or the agent exited. */
    endRun(conversationId: string): void;
    /**
     * The running response is waiting for the person: an approval, a question, or a form from a connected server. Told when
     * the card appears, not when it is answered. The host may send a notification; it must not wait for anything.
     */
    needsAnswer?(userId: string, conversationId: string, kind: "approval" | "question" | "input"): void;
}

let runHooks: RunHooks | undefined;

/** Tell the host when responses start and end, so it can grant and release control of the computer to them. */
export function setRunHooks(hooks: RunHooks | undefined): void {
    runHooks = hooks;
}

export function runLifecycle(): RunHooks | undefined {
    return runHooks;
}
