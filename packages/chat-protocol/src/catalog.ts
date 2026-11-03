/**
 * Curated catalogues for the settings UI: model providers and MCP servers people commonly add.
 * Each entry declares only the inputs it needs, so the UI can ask for one API key instead of
 * showing every field of the underlying config.
 */
import type { ModelInfo } from "./models.ts";
import type { McpCatalogEntry, Provider } from "./settings.ts";

export interface CatalogInput {
    /** Where the value goes: a provider field, an MCP env var, an MCP header, or an argument placeholder. */
    target:
        | { kind: "apiKey" }
        | { kind: "baseUrl" }
        | { kind: "env"; name: string }
        | { kind: "header"; name: string; prefix?: string }
        | { kind: "arg"; placeholder: string };
    label: string;
    help?: string;
    /** Link to where the user gets the value (key page, token settings). */
    url?: string;
    secret?: boolean;
    optional?: boolean;
    defaultValue?: string;
}

export interface ProviderPreset {
    id: string;
    name: string;
    description: string;
    /** Provider entry written when added (inputs fill in the rest). */
    provider: Partial<Provider>;
    inputs: CatalogInput[];
    kind: "cloud" | "local" | "router";
}

/** A catalogue entry with its id. The built-in list is `mcpPresets`; administrators add more (`system.mcp.catalog`). */
export type McpPreset = McpCatalogEntry & { id: string };

const apiKey = (url: string, label = "API key"): CatalogInput => ({
    target: { kind: "apiKey" },
    label,
    url,
    secret: true,
});

export const providerPresets: ProviderPreset[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        description: "Claude models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://console.anthropic.com/settings/keys")],
    },
    {
        id: "openai",
        name: "OpenAI",
        description: "GPT and o-series models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://platform.openai.com/api-keys")],
    },
    {
        id: "google",
        name: "Google",
        description: "Gemini models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://aistudio.google.com/apikey")],
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        description: "Hundreds of models through one key",
        kind: "router",
        provider: {},
        inputs: [apiKey("https://openrouter.ai/settings/keys")],
    },
    {
        id: "groq",
        name: "Groq",
        description: "Fast open models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://console.groq.com/keys")],
    },
    {
        id: "mistral",
        name: "Mistral",
        description: "Mistral and Codestral models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://console.mistral.ai/api-keys")],
    },
    {
        id: "xai",
        name: "xAI",
        description: "Grok models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://console.x.ai")],
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        description: "DeepSeek chat and reasoning models",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://platform.deepseek.com/api_keys")],
    },
    {
        id: "together",
        name: "Together AI",
        description: "Open models in the cloud",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://api.together.ai/settings/api-keys")],
    },
    {
        id: "fireworks",
        name: "Fireworks",
        description: "Open models in the cloud",
        kind: "cloud",
        provider: {},
        inputs: [apiKey("https://fireworks.ai/account/api-keys")],
    },
    {
        id: "typesafe",
        name: "TypeSafe",
        description: "Jev decision models",
        kind: "cloud",
        // The API root: Chat calls `/v1/systemone` and `/v1/models` under it (docs/spec/model-roles.md 9.2).
        provider: { api: "systemone", baseUrl: "https://api.typesafe.ai" },
        inputs: [apiKey("https://console.typesafe.ai/")],
    },
    {
        id: "ollama",
        name: "Ollama",
        description: "Models running on your own machine",
        kind: "local",
        provider: { api: "openai-completions", discovery: { type: "ollama" } },
        inputs: [
            {
                target: { kind: "baseUrl" },
                label: "Server address",
                defaultValue: "http://host.docker.internal:11434/v1",
                help: "The address of your Ollama server as this Chat server can reach it.",
            },
        ],
    },
    {
        id: "lm-studio",
        name: "LM Studio",
        description: "Models from the LM Studio local server",
        kind: "local",
        provider: { api: "openai-completions", discovery: { type: "lm-studio" } },
        inputs: [
            {
                target: { kind: "baseUrl" },
                label: "Server address",
                defaultValue: "http://host.docker.internal:1234/v1",
            },
        ],
    },
];

export const customProviderPreset: ProviderPreset = {
    id: "custom",
    name: "Custom endpoint",
    description: "Any OpenAI, Anthropic or Gemini compatible API",
    kind: "cloud",
    provider: { api: "openai-completions", discovery: { type: "openai-models-list" } },
    inputs: [
        { target: { kind: "baseUrl" }, label: "Base URL", help: "For example https://llm.example.com/v1" },
        { target: { kind: "apiKey" }, label: "API key", secret: true, optional: true },
    ],
};

/**
 * Built-in MCP catalogue. Remote servers connect through the Chat MCP gateway (OAuth tokens and keys stay on the
 * server); command servers run in the user's sandbox. Logos come from `logoDomain` through the server's logo cache.
 */
export const mcpPresets: McpPreset[] = [
    {
        id: "github",
        name: "GitHub",
        tagline: "Issues, pull requests and code",
        description:
            "Read and change repositories, issues and pull requests, search code and check Actions runs. Sign in " +
            "with your GitHub account, or paste a personal access token.",
        publisher: "GitHub",
        category: "developer",
        website: "https://github.com/github/github-mcp-server",
        logoDomain: "github.com",
        auth: "oauth",
        starters: ["Summarise my open pull requests", "Which issues were opened in the last week?"],
        server: { type: "http", url: "https://api.githubcopilot.com/mcp/", oauth: {} },
        inputs: [],
        note: "Can read and change repositories your account can access.",
    },
    {
        id: "linear",
        name: "Linear",
        tagline: "Plan and track issues",
        description: "Find, create and update Linear issues, projects and comments with your Linear account.",
        publisher: "Linear",
        category: "productivity",
        website: "https://linear.app/docs/mcp",
        logoDomain: "linear.app",
        auth: "oauth",
        starters: ["What is assigned to me this cycle?"],
        server: { type: "http", url: "https://mcp.linear.app/mcp", oauth: {} },
        inputs: [],
    },
    {
        id: "notion",
        name: "Notion",
        tagline: "Pages, docs and databases",
        description: "Search your Notion workspace, read pages and databases, and create or update pages.",
        publisher: "Notion",
        category: "productivity",
        website: "https://developers.notion.com/docs/mcp",
        logoDomain: "notion.so",
        auth: "oauth",
        starters: ["Find my notes about the release plan"],
        server: { type: "http", url: "https://mcp.notion.com/mcp", oauth: {} },
        inputs: [],
    },
    {
        id: "sentry",
        name: "Sentry",
        tagline: "Errors and performance issues",
        description: "Look up Sentry issues, events and releases, and ask for a root-cause analysis.",
        publisher: "Sentry",
        category: "developer",
        website: "https://docs.sentry.io/product/sentry-mcp/",
        logoDomain: "sentry.io",
        auth: "oauth",
        server: { type: "http", url: "https://mcp.sentry.dev/mcp", oauth: {} },
        inputs: [],
    },
    {
        id: "supabase",
        name: "Supabase",
        tagline: "Manage and query databases",
        description: "Run SQL, inspect schemas, read logs and manage Supabase projects and branches.",
        publisher: "Supabase",
        category: "data",
        website: "https://supabase.com/docs/guides/getting-started/mcp",
        logoDomain: "supabase.com",
        auth: "oauth",
        server: { type: "http", url: "https://mcp.supabase.com/mcp", oauth: {} },
        inputs: [],
        note: "Can change data and schemas in projects your account can access.",
    },
    {
        id: "hugging-face",
        name: "Hugging Face",
        tagline: "Models, datasets and Spaces",
        description: "Search models, datasets, papers and Spaces on the Hugging Face Hub.",
        publisher: "Hugging Face",
        category: "knowledge",
        website: "https://huggingface.co/settings/mcp",
        logoDomain: "huggingface.co",
        auth: "oauth",
        server: { type: "http", url: "https://huggingface.co/mcp", oauth: {} },
        inputs: [],
    },
    {
        id: "context7",
        name: "Context7",
        tagline: "Current library documentation",
        description: "Up-to-date documentation and code examples for thousands of libraries.",
        publisher: "Upstash",
        category: "developer",
        website: "https://context7.com",
        logoDomain: "context7.com",
        auth: "token",
        server: { type: "http", url: "https://mcp.context7.com/mcp" },
        inputs: [
            {
                target: { kind: "header", name: "CONTEXT7_API_KEY" },
                label: "API key",
                secret: true,
                optional: true,
                url: "https://context7.com/dashboard",
            },
        ],
    },
    {
        id: "deepwiki",
        name: "DeepWiki",
        tagline: "Ask about public repositories",
        description: "Ask questions about public GitHub repositories and read their generated documentation.",
        publisher: "Cognition",
        category: "knowledge",
        website: "https://deepwiki.com",
        logoDomain: "deepwiki.com",
        auth: "none",
        server: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
        inputs: [],
    },
    {
        id: "cloudflare-docs",
        name: "Cloudflare docs",
        tagline: "Search Cloudflare documentation",
        description: "Search the Cloudflare developer documentation.",
        publisher: "Cloudflare",
        category: "knowledge",
        website: "https://developers.cloudflare.com/agents/model-context-protocol/",
        logoDomain: "cloudflare.com",
        auth: "none",
        server: { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
        inputs: [],
    },
    {
        id: "executor",
        name: "Executor",
        tagline: "Your own MCP gateway",
        description:
            "Connect a self-hosted Executor gateway. Every integration you configure there becomes available here, " +
            "with Executor's own approval policies.",
        publisher: "Executor",
        category: "utilities",
        auth: "oauth",
        server: { type: "http", oauth: {} },
        inputs: [
            { target: { kind: "url" }, label: "Gateway address", help: "For example https://exe.example.com/mcp" },
        ],
    },
    {
        id: "fetch",
        name: "Fetch",
        tagline: "Web pages as markdown",
        description: "Fetch web pages and turn them into markdown. Runs in your sandbox.",
        publisher: "Model Context Protocol",
        category: "utilities",
        website: "https://github.com/modelcontextprotocol/servers",
        auth: "none",
        server: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
        inputs: [],
    },
    {
        id: "sequential-thinking",
        name: "Sequential thinking",
        tagline: "Step-by-step reasoning",
        description: "A structured step-by-step reasoning tool. Runs in your sandbox.",
        publisher: "Model Context Protocol",
        category: "utilities",
        website: "https://github.com/modelcontextprotocol/servers",
        auth: "none",
        server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
        inputs: [],
    },
    {
        id: "playwright",
        name: "Playwright",
        tagline: "Drive a headless browser",
        description: "Open pages, click, type and take screenshots in a headless browser. Runs in your sandbox.",
        publisher: "Microsoft",
        category: "developer",
        website: "https://github.com/microsoft/playwright-mcp",
        logoDomain: "playwright.dev",
        auth: "none",
        server: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] },
        inputs: [],
        note: "Needs a browser download the first time it runs.",
    },
    {
        id: "memory",
        name: "Knowledge graph",
        tagline: "Facts the assistant keeps",
        description: "A small graph of facts the assistant can keep and query. Runs in your sandbox.",
        publisher: "Model Context Protocol",
        category: "knowledge",
        website: "https://github.com/modelcontextprotocol/servers",
        auth: "none",
        server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
        inputs: [],
        note: "Stores its graph in your sandbox home folder.",
    },
    {
        id: "time",
        name: "Time",
        tagline: "Time zones and conversion",
        description: "Current time and time zone conversion. Runs in your sandbox.",
        publisher: "Model Context Protocol",
        category: "utilities",
        website: "https://github.com/modelcontextprotocol/servers",
        auth: "none",
        server: { type: "stdio", command: "uvx", args: ["mcp-server-time"] },
        inputs: [],
    },
];

/** Built-in featured order when `system.mcp.featured` is empty. */
export const defaultFeaturedMcp = ["github", "linear", "notion", "context7"];

export const customMcpPreset: McpPreset = {
    id: "custom",
    name: "Custom server",
    tagline: "Any MCP server by address or command",
    description: "Any MCP server by URL or command",
    category: "utilities",
    auth: "none",
    server: { type: "http" },
    inputs: [],
};

/** One catalogue entry as GET /api/mcp/catalog returns it. */
export interface McpCatalogItem extends McpPreset {
    /** Served by Chat (`/api/mcp/logos/<id>`), or undefined when the entry has no logo. */
    logo?: string;
    /** `builtin` entries ship with Chat; `admin` entries come from `system.mcp.catalog`. */
    source: "builtin" | "admin";
    /** False when `policy.mcp.allow` does not let this user add it (an administrator can still add it for everyone). */
    allowed: boolean;
}

/** GET /api/mcp/catalog. */
export interface McpCatalogResponse {
    entries: McpCatalogItem[];
    /** Ids in Featured order. */
    featured: string[];
    custom: McpPreset;
    /** Users may add their own servers (`policy.users.customMcp`). */
    canAdd: boolean;
}

/** All four tool annotations, as the server sent them. Hints only: the server may not tell the truth. */
export interface McpToolHints {
    title?: string;
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
}

/** One OAuth connection of the signed-in user (GET /api/mcp/connections). Never carries a token. */
export interface McpConnection {
    /** The `agent.mcp` record id. */
    server: string;
    status: "connected" | "expired" | "needs_more_access";
    /** Who the user signed in as, when the server or its authorisation server said. */
    account?: string;
    scopes: string[];
    /** Extra scopes the server asked for (403 insufficient_scope); Reconnect asks for them too. */
    missingScopes?: string[];
    issuer: string;
    /** Epoch ms when the access token ends, if the server said. */
    expiresAt?: number;
    connectedAt: number;
}

/** POST /api/mcp/discover: what a server address offers, before anything is saved. */
export interface McpDiscovery {
    ok: boolean;
    url: string;
    /** Spec era the server answered in: 2025-11-25 style (`initialize`) or 2026-07-28 style (`server/discover`). */
    era?: "stateful" | "stateless";
    protocolVersion?: string;
    transport?: "http" | "sse";
    auth: "none" | "oauth" | "unknown";
    /** OAuth details from protected resource metadata, when the server wants a sign-in. */
    oauth?: {
        issuer?: string;
        scopes?: string[];
        resourceName?: string;
        registration?: "metadata" | "dynamic" | "none";
    };
    serverName?: string;
    serverTitle?: string;
    serverVersion?: string;
    instructions?: string;
    /** Only when the server lists tools without a sign-in. */
    tools?: McpToolSummary[];
    latencyMs: number;
    /** Never contains a secret. */
    error?: string;
}

/** GET /api/mcp/servers/:id/inventory: what a connected server offers (tools, prompts, resources). */
export interface McpInventory {
    server: string;
    serverName?: string;
    serverVersion?: string;
    protocolVersion?: string;
    era?: "stateful" | "stateless";
    tools: McpToolSummary[];
    prompts: {
        name: string;
        title?: string;
        description?: string;
        arguments?: { name: string; required?: boolean }[];
    }[];
    resources: { uri: string; name: string; title?: string; description?: string; mimeType?: string }[];
    resourceTemplates: { uriTemplate: string; name: string; title?: string; description?: string }[];
    /** Set when the listing failed; the lists are then empty. Never contains a secret. */
    error?: string;
    /** The server wants a sign-in (or a new one) before it lists anything. */
    needsAuth?: boolean;
}

export interface ProviderTestResult {
    ok: boolean;
    status?: number;
    latencyMs: number;
    /** Model ids the endpoint reported, when it has a list endpoint. */
    models: string[];
    /** Never contains a secret: the server replaces every secret value of the entry with the mask. */
    error?: string;
}

export interface McpToolSummary {
    /** The tool name the server reports (the key of `McpServer.tools`). */
    name: string;
    description?: string;
    /** From the server's tool annotations, when it sends them. */
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
    /** Display title (`title`, else `annotations.title`). */
    title?: string;
    /** MCP Apps: the `ui://` resource the tool renders with (`_meta.ui.resourceUri`), when it has one. */
    uiResource?: string;
}

export interface McpTestResult {
    ok: boolean;
    latencyMs: number;
    serverName?: string;
    serverVersion?: string;
    /** The transport that answered: Streamable HTTP, or the older HTTP with SSE. */
    transport?: "http" | "sse";
    /** Set when the server asks for an OAuth sign-in (401 with a bearer challenge). */
    auth?: "oauth";
    tools: McpToolSummary[];
    /** Tools left out because the list was longer than the server sends to the browser. */
    truncated?: number;
    /** Never contains a secret: the server replaces every secret value of the entry with the mask. */
    error?: string;
}

/** One MCP server as the user's sandbox sees it (GET /api/mcp). */
export interface McpServerStatus {
    name: string;
    type: "stdio" | "http" | "sse";
    owner: "global" | "user" | "builtin";
    connected: boolean;
    error?: string;
    tools: McpToolStatus[];
}

export interface McpToolStatus {
    /** Name the agent uses, for example mcp__github_create_issue. */
    name: string;
    /** The tool name the server reports, the key of `McpServer.tools`. */
    tool?: string;
    /** server/tool, for display. */
    label: string;
    description: string;
}

/** GET /api/providers/:id/models: one provider's models, including the ones turned off. */
export interface ProviderModelsResponse {
    /** Every model the runtime listed for this provider, with metadata. */
    models: ModelInfo[];
    /** Model ids turned off on this entry (`disabledModels`). */
    disabled: string[];
    /** Model ids the model policy (`policy.models.*`) blocks for this account. */
    blocked: string[];
    /** When the runtime last listed the models (ms since epoch), if ever. */
    checkedAt?: number;
    /** False while the listing was made for an older configuration (a refresh is running). */
    current: boolean;
    error?: string;
}
