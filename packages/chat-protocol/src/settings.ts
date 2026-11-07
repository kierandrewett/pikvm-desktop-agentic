/**
 * Settings registry: the single declared contract for every configurable value in Chat.
 *
 * Storage is a flat key/value table. Keys are dotted paths. Global keys live at the top level
 * (`agent.mcp`). A user-scoped twin of a key has the same shape and lives under `users.<userId>.`
 * (`users.u_abc.agent.mcp`). Unregistered keys under `users.<userId>.` are free-form user space.
 *
 * Every key declares how its user twin behaves:
 * - `none`     no user twin; the key is global only (system internals)
 * - `admin`    user twin exists but only admins write it (per-user quota, per-user policy)
 * - `user`     user twin exists and the user owns it (preferences, own providers, own MCP)
 *
 * Every key declares how the global value and the user twin combine:
 * - `override` user value wins when set, else global, else default
 * - `record`   map keyed by id; entries combine; on a collision the global entry wins
 */
import { z } from "zod";
import { modelFeatureIds } from "./model-features.ts";
import { SidebarSections } from "./sidebar-view.ts";

export const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
export const USERS_PREFIX = "users";
export const SECRET_MASK = "********";

export type UserTwin = "none" | "admin" | "user";
export type MergeRule = "override" | "record";

export interface SettingDef<T = unknown> {
    key: string;
    schema: z.ZodType<T>;
    default: T;
    description: string;
    userTwin: UserTwin;
    merge: MergeRule;
    /**
     * Path patterns (relative to the value) whose leaves are secrets. `*` matches one segment.
     * Secrets are masked on read and kept on write when the client sends the mask back.
     */
    secrets?: string[];
    /** Expose the effective value to the browser bootstrap without an extra request. */
    public?: boolean;
}

/** Infer the value type from the schema only, so a literal default cannot widen it. */
function def<K extends string, T>(
    d: Omit<SettingDef<T>, "default"> & { key: K; default: NoInfer<T> },
): SettingDef<T> & { key: K } {
    return d;
}

// Shapes shared by global and user twins.

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** A stored default may also be "auto": the runtime picks an effort per message (see ThinkingSelector). */
export const ThinkingLevel = z.enum([...thinkingLevels, "auto"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

export const providerApis = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "google-vertex",
    "bedrock-converse-stream",
    /**
     * Typed decisions (yes/no, choice, score) at `<baseUrl>/v1/systemone`, for the `decisions` role only. Not a chat
     * API: these providers are not written to the runtime's models.yml (docs/spec/model-roles.md 9).
     */
    "systemone",
] as const;

export const ProviderModel = z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

/** A model provider. The record id is the provider id the agent runtime sees (`anthropic`, `my-gateway`). */
export const Provider = z.object({
    enabled: z.boolean().default(true),
    label: z.string().optional(),
    /** Omit for built-in providers that only need a key. Required for custom endpoints. */
    baseUrl: z.url().optional(),
    api: z.enum(providerApis).optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(ProviderModel).optional(),
    discovery: z
        .object({ type: z.enum(["openai-models-list", "ollama", "llama.cpp", "lm-studio", "litellm", "proxy"]) })
        .optional(),
    /**
     * Model ids (as the provider lists them) that are turned off: hidden from the model picker and refused like a
     * policy deny. Absent or empty means every model is on, so older values need no migration.
     */
    disabledModels: z.array(z.string().min(1)).optional(),
});
export type Provider = z.infer<typeof Provider>;
export const Providers = z.record(z.string().regex(SEGMENT_RE), Provider);

/** Per-tool MCP policy. The runtime gets `prompt` for `ask` and `deny` for `off` (see agent/config.ts). */
export const mcpToolPolicies = ["ask", "off"] as const;
export const McpToolPolicy = z.enum(mcpToolPolicies);
export type McpToolPolicy = z.infer<typeof McpToolPolicy>;

export const McpServer = z.object({
    enabled: z.boolean().default(true),
    type: z.enum(["stdio", "http", "sse"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().nonnegative().optional(),
    /**
     * Per-tool policy, keyed by the tool name the server reports. `ask` asks before every call, also with full
     * access; `off` refuses every call. A tool without an entry follows the chat's permission mode. Absent means no
     * overrides, so older values need no migration.
     */
    tools: z.record(z.string().min(1), McpToolPolicy).optional(),
    /**
     * OAuth sign-in through the Chat MCP gateway (docs/spec/mcp-support.md). Present means each user connects their
     * own account; tokens stay on the Chat server. `clientId` / `clientSecret` are a pre-registered client; without
     * them Chat uses a client ID metadata document or dynamic registration. `scopes` are asked for in addition to
     * the ones the server names in its challenge. Absent means no OAuth, so older values need no migration.
     */
    oauth: z
        .object({
            clientId: z.string().min(1).optional(),
            clientSecret: z.string().optional(),
            scopes: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    /** The catalogue entry this server was added from, for its logo and detail page. */
    catalogId: z.string().regex(SEGMENT_RE).optional(),
});
export type McpServer = z.infer<typeof McpServer>;
export const McpServers = z.record(z.string().regex(SEGMENT_RE), McpServer);

/**
 * Server ids that name Chat's own MCP endpoints in each user's generated agent config (`conversations`, `plugins`).
 * A configured `agent.mcp` entry may not use them: the settings store refuses the write with a 400, and the
 * generator and the gateway ignore a leftover entry.
 */
export const RESERVED_MCP_SERVER_IDS: ReadonlySet<string> = new Set(["conversations", "pikvm"]);

/** Catalogue categories, in display order. */
export const mcpCategories = [
    "developer",
    "productivity",
    "knowledge",
    "data",
    "communication",
    "design",
    "utilities",
] as const;
export type McpCategory = (typeof mcpCategories)[number];

/** One value a catalogue entry asks for when it is added (an MCP env var, header or argument placeholder). */
export const McpCatalogInput = z.object({
    target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("env"), name: z.string().min(1) }),
        z.object({ kind: z.literal("header"), name: z.string().min(1), prefix: z.string().optional() }),
        z.object({ kind: z.literal("arg"), placeholder: z.string().min(1) }),
        /** The server address itself, for self-hosted servers (the entry's `server.url` is the example). */
        z.object({ kind: z.literal("url") }),
    ]),
    label: z.string().min(1),
    help: z.string().optional(),
    url: z.url().optional(),
    secret: z.boolean().optional(),
    optional: z.boolean().optional(),
    defaultValue: z.string().optional(),
});

export type McpCatalogInput = z.infer<typeof McpCatalogInput>;

/**
 * A catalogue entry: a server people can add in a few clicks. The built-in list is in catalog.ts; administrators add
 * their own with `system.mcp.catalog`. `server` is the entry written to `agent.mcp` when the user adds it.
 */
export const McpCatalogEntry = z.object({
    name: z.string().min(1).max(80),
    /** One line, a few words, for the directory row. */
    tagline: z.string().max(120).optional(),
    /** Longer text for the detail page. */
    description: z.string().max(2000),
    publisher: z.string().max(80).optional(),
    category: z.enum(mcpCategories).default("utilities"),
    website: z.url().optional(),
    privacy: z.url().optional(),
    /** Domain whose icon is the logo (fetched and cached by the server, never by the browser). */
    logoDomain: z
        .string()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
        .optional(),
    /** How users sign in: nothing, their own OAuth account, or a token they paste. */
    auth: z.enum(["none", "oauth", "token"]).default("none"),
    /** Example prompts shown on the detail page; each opens a new chat with that text. */
    starters: z.array(z.string().max(300)).max(4).optional(),
    /** Shown before adding: what the server can do with the user's data. */
    note: z.string().max(500).optional(),
    server: McpServer.partial(),
    inputs: z.array(McpCatalogInput).default([]),
});
export type McpCatalogEntry = z.infer<typeof McpCatalogEntry>;

/** How the MCP gateway uses tool annotations (agent.mcpApprovals). */
export const McpApprovals = z.object({
    /** Tools that say they only read (`readOnlyHint`) run without asking unless a per-tool policy says otherwise. */
    trustReadOnly: z.boolean().default(true),
    /** Tools that say they destroy data (`destructiveHint`) always ask first, also with full access. */
    confirmDestructive: z.boolean().default(true),
});
export type McpApprovals = z.infer<typeof McpApprovals>;

/** Social login providers the auth layer supports. The record key in `auth.social` must be one of these. */
/**
 * A model for one of the agent's model roles, as `provider/model`, or empty for the runtime's choice. One model only:
 * no fallback lists, so the model policy can check it (agent/config.ts drops a model the policy refuses).
 */
const ROLE_MODEL_RE = /^[A-Za-z0-9._-]+\/[^\s,]+$/;
const RoleModel = z.union([z.literal(""), z.string().max(300).regex(ROLE_MODEL_RE, "Use provider/model")]);

/** Where speech audio goes. `provider` reuses an entry of agent.providers (its base URL and key). */
/**
 * Per-model feature overrides: a `provider/model` glob (same rules as `policy.models.allow`) to feature id to
 * on/off. Feature ids come from the registry in model-features.ts; resolution rules are documented there.
 */
export const ModelFeatureOverridesSchema = z.record(
    z.string().min(1).max(200).regex(/^\S+$/, "Patterns have no spaces"),
    z.partialRecord(z.enum(modelFeatureIds), z.boolean()),
);

export const SpeechEndpoint = z.object({
    mode: z.enum(["off", "browser", "server"]).default("browser"),
    provider: z.string().default(""),
    baseUrl: z.string().default(""),
    apiKey: z.string().default(""),
});

export const ThemeSeed = z.object({
    accent: z.string().optional(),
    surface: z.string().optional(),
    ink: z.string().optional(),
    contrast: z.number().min(0).max(100).optional(),
});
export type ThemeSeed = z.infer<typeof ThemeSeed>;

const bytes = z.number().int().nonnegative();

export const settingDefs = [
    def({
        key: "system.agent.binary",
        schema: z.string().min(1),
        default: "omp",
        description: "Agent runtime executable.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.agent.idleTimeoutSec",
        schema: z.number().int().min(30),
        default: 600,
        description: "Stop an idle agent process after this many seconds.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.agent.maxProcesses",
        schema: z.number().int().min(1),
        default: 32,
        description: "Maximum agent processes across all users.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.agent.maxResponseMinutes",
        schema: z.number().int().min(0),
        default: 30,
        description: "Stop a response still running after this many minutes. 0 means no limit.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.agent.queueTimeoutSec",
        // The web client stops waiting for a response to start after 180 s (lib/send.ts), so a longer wait would end
        // without the client hearing why.
        schema: z.number().int().min(0).max(170),
        default: 120,
        description:
            "How long a prompt waits for a free agent process when every slot is busy, in seconds. " +
            "After this the prompt fails with a process limit error. 0 turns the queue off.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.modelsDev.url",
        schema: z.url(),
        default: "https://models.dev",
        description: "Base URL of the models.dev catalogue (metadata and logos).",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.modelsDev.refreshHours",
        schema: z.number().min(1),
        default: 24,
        description: "How often to refresh the models.dev catalogue.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "system.mcp.allowPrivateNetworks",
        schema: z.boolean(),
        default: false,
        description:
            "Let the MCP gateway reach private, loopback and link-local addresses (and plain http) for servers users " +
            "add and for every OAuth discovery, registration and token URL. Off blocks them, which protects services " +
            "on the server's own network. Servers an administrator adds may always use their own address.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.providers",
        schema: Providers,
        default: {},
        description: "Model providers. Global providers are proxied so their keys never reach a sandbox.",
        userTwin: "user",
        merge: "record",
        secrets: ["*.apiKey", "*.headers.*"],
    }),
    def({
        key: "agent.mcp",
        schema: McpServers,
        default: {},
        description: "MCP servers available to the agent.",
        userTwin: "user",
        merge: "record",
        secrets: ["*.env.*", "*.headers.*", "*.oauth.clientSecret"],
    }),
    def({
        key: "agent.mcpApprovals",
        schema: McpApprovals,
        default: { trustReadOnly: true, confirmDestructive: true },
        description:
            "How tool annotations from remote MCP servers change approvals. `trustReadOnly`: tools marked read-only run " +
            "without asking (a per-tool policy still wins). `confirmDestructive`: tools marked destructive always ask " +
            "in the chat first, also with full access.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.defaultModel",
        schema: z.string(),
        default: "",
        description: "Default model as `provider/model`. Empty uses the first available model.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.defaultThinking",
        schema: ThinkingLevel,
        default: "medium",
        description: "Default reasoning effort for new chats.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.permission",
        schema: z.enum(["default", "full"]),
        default: "default",
        description: "`default` asks before running commands; `full` runs tools without asking.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.instructions",
        schema: z.string().max(20000),
        default: "",
        description: "Extra instructions appended to the agent system prompt.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.disabledTools",
        schema: z.array(z.string()),
        default: [] as string[],
        description: "Agent tools to disable.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.conversationsTool",
        schema: z.boolean(),
        default: false,
        description:
            "Give the agent tools to list, search, read and rename the user's other conversations. Off by default: the computer profile offers only the computer tools.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.titleGeneration",
        schema: z.boolean(),
        default: true,
        description: "Generate chat titles automatically.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.subscriptions",
        schema: z.partialRecord(z.enum(["anthropic", "openai-codex"]), z.object({ signedInAt: z.number().int().nonnegative() })),
        default: {},
        description:
            "Model subscriptions this user signed in to (Claude, ChatGPT/Codex), with when. The credential itself is kept by the agent runtime " +
            "in the user's own home; this only says that a sign-in finished, so Settings can show it after a reload. Written by the server.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.memory.enabled",
        schema: z.boolean(),
        default: false,
        description:
            "Per-user memory. The agent remembers facts across this user's chats: completed turns are retained into a private store " +
            "and recalled at the start of a chat, and the agent can recall, retain, reflect on and forget memories itself. Off by default.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.askTimeoutSec",
        schema: z.number().int().min(0).max(3600),
        default: 0,
        description:
            "Seconds the assistant waits when it asks you a question. After that it takes its recommended option and continues. 0 waits until you answer.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.modelRoles.smol",
        schema: RoleModel,
        default: "",
        description:
            "Fast: a quick, low-cost model for light work such as quick subagents, as `provider/model`. Empty uses " +
            "the default model.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.modelRoles.slow",
        schema: RoleModel,
        default: "",
        description:
            "Thinking: a strong reasoning model for thorough work such as deep-analysis subagents and the reviewer, " +
            "as `provider/model`. Empty uses the default model.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.modelRoles.tiny",
        schema: RoleModel,
        default: "",
        description:
            "Small tasks: chat titles, chat icons, memory extraction and other short background calls, as " +
            "`provider/model`. Empty uses the Fast model, then the default model, then the chat's own model.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.modelRoles.decisions",
        schema: RoleModel,
        default: "",
        description:
            "Decisions: a model that answers short yes/no questions, as `provider/model`. A decisions model on OpenRouter " +
            "(Jev, Perplexity Decider, Liquid d1 and others) answers natively for a fraction of a chat model's price; any " +
            "chat model answers through a JSON call. The screen watch asks it first and drops pop-ups that are plainly " +
            "noise before the chat model reads anything. Empty turns it off; there is no fallback.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "agent.compaction",
        schema: z.object({
            /** Summarise earlier messages automatically when the context window fills up. */
            enabled: z.boolean().default(true),
            /** Context fill, in percent, that starts a summary. 0 uses the runtime's own threshold. */
            thresholdPercent: z.number().int().min(0).max(95).default(0),
        }),
        default: { enabled: true, thresholdPercent: 0 },
        description:
            "Context compaction: when a chat fills the model's context window, earlier messages are replaced by a " +
            "summary so the chat can go on. `thresholdPercent` 0 uses the runtime's default point. Off: a full chat " +
            "fails until you start a new one or compact it by hand with /compact.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "models.features",
        schema: ModelFeatureOverridesSchema,
        default: {},
        description:
            "Your own model feature opt-outs, same shape and matching as `policy.models.features`. Only features that " +
            "allow it are affected (reactions). You cannot turn on a feature an administrator turned off.",
        userTwin: "user",
        merge: "override",
    }),
    def({
        key: "speech.transcription",
        schema: SpeechEndpoint.extend({ model: z.string().default("gpt-4o-mini-transcribe"), language: z.string().default("") }),
        default: { mode: "browser", provider: "", baseUrl: "", apiKey: "", model: "gpt-4o-mini-transcribe", language: "" },
        description:
            "Dictation in the composer. `browser` uses the browser's speech recognition; `server` sends audio to a speech-to-text endpoint with the common /audio/transcriptions API (a provider id from agent.providers, or its own base URL and key).",
        userTwin: "user",
        merge: "override",
        secrets: ["apiKey"],
        public: true,
    }),
    def({
        key: "speech.tts",
        schema: SpeechEndpoint.extend({ model: z.string().default("gpt-4o-mini-tts"), voice: z.string().default("alloy") }),
        default: { mode: "browser", provider: "", baseUrl: "", apiKey: "", model: "gpt-4o-mini-tts", voice: "alloy" },
        description:
            "Read aloud. `browser` uses the browser's speech synthesis; `server` calls a text-to-speech endpoint with the common /audio/speech API.",
        userTwin: "user",
        merge: "override",
        secrets: ["apiKey"],
        public: true,
    }),
    def({
        key: "ui.theme.mode",
        schema: z.enum(["system", "light", "dark"]),
        default: "system",
        description: "Colour mode.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.theme.preset",
        schema: z.string(),
        default: "chat",
        description: "Theme preset id.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.theme.light",
        schema: ThemeSeed,
        default: {},
        description: "Light mode seed overrides on top of the preset.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.theme.dark",
        schema: ThemeSeed,
        default: {},
        description: "Dark mode seed overrides on top of the preset.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.font.ui",
        schema: z.string(),
        default: "",
        description: "UI font family. Empty uses the bundled Geist font.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.font.code",
        schema: z.string(),
        default: "",
        description: "Code font family. Empty uses the system monospace font.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.font.uiSize",
        schema: z.number().int().min(11).max(20),
        default: 14,
        description: "UI font size in px.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.font.codeSize",
        schema: z.number().int().min(10).max(20),
        default: 12,
        description: "Code font size in px.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.roundness",
        schema: z.number().min(0).max(2),
        default: 1,
        description: "Corner roundness multiplier for the whole interface (0 square, 1 default, 2 extra round).",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.density",
        schema: z.enum(["compact", "default", "comfortable"]),
        default: "default",
        description: "Spacing and row height across the interface.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.motion.speed",
        schema: z.number().min(0).max(3),
        default: 1,
        description: "Animation duration multiplier: 0 turns animation off, 0.5 is twice as fast, 2 is twice as slow.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.motion.curve",
        schema: z.enum(["reference", "smooth", "snappy", "spring", "linear"]),
        default: "reference",
        description: "Easing curves for every transition and animation.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.sidebar.width",
        schema: z.number().min(200).max(600),
        default: 320,
        description: "Sidebar width in px.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.sidebar.searchButton",
        schema: z.enum(["global", "filter"]),
        default: "filter",
        description:
            'What the chat sidebar\'s search button does: "global" opens search across everything; "filter" opens a filter field under the sidebar header that narrows the chat list.',
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.sidebar.sections",
        schema: SidebarSections,
        default: {} as z.infer<typeof SidebarSections>,
        description:
            "How the sidebar's Pinned, Projects and Chats sections sort, group, filter and limit their rows, set from each section's menu. One value for all three, because a change is one write and Reset view is one delete. A missing field uses the section's default (sidebar-view.ts).",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.sidebar.expandedRows",
        schema: z.boolean(),
        default: false,
        description:
            "Show each chat in the sidebar as an expanded row: the title, a line with the model, time and project or agent, and the start of the last reply. Independent of ui.density, which sets the padding of both row styles.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.models.favorites",
        schema: z.array(z.string()),
        default: [] as string[],
        description: "Favourite models as `provider/model`, in shortcut order.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.models.groupBy",
        schema: z.enum(["vendor", "provider"]),
        default: "vendor",
        description:
            "How the model picker groups models: by the lab that made them (vendor) or by the provider that serves them.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.islands",
        schema: z.boolean(),
        default: true,
        description: "Inset the page with a gutter and rounded corners. When false the page fills the window next to the rail.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.mobile.panelStyle",
        schema: z.enum(["rounded", "flat"]),
        default: "rounded",
        description:
            "Phones only: how the sidebar drawer and the side panel meet the page. `rounded`: the page beside the open drawer reads as a card with rounded corners on that edge, and the side panel has rounded corners on its page side with a strip of the page showing. `flat`: square edges, and the side panel fills the screen.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.blur",
        schema: z.boolean(),
        default: true,
        description:
            "Content scrolls under translucent, blurred headers. When false, or when the system asks for reduced transparency, headers are solid. The composer has its own setting (ui.composer.dock).",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.composer.dock",
        schema: z.enum(["fade", "solid"]),
        default: "fade",
        description:
            '"fade": the thread scrolls behind the docked composer and fades into a progressive blur above it. "solid": the composer sits on a solid background and the thread stops above it. Without backdrop blur support, or with reduced transparency, it is solid.',
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.composer.fadeHeight",
        schema: z.number().int().min(16).max(160),
        default: 56,
        description: 'How far above the composer the fade reaches, in px, when ui.composer.dock is "fade".',
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.composer.enterToSend",
        schema: z.boolean(),
        default: true,
        description: "Enter sends, Shift+Enter adds a new line. When false, Ctrl+Enter sends.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.composer.pasteAsFileChars",
        schema: z.number().int().min(0).max(1_000_000),
        default: 10_000,
        description:
            "Pasted text longer than this many characters becomes a file attachment instead of prompt text. 0 keeps all pasted text in the message.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.thread.avatars",
        schema: z.boolean(),
        default: false,
        description: "Show avatars in conversations: yours on your messages, the model's logo on replies.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.thread.minimap",
        schema: z.boolean(),
        default: true,
        description:
            "Show a minimap of long conversations at the right edge of the thread, on wide screens. Click or drag it to move through the chat.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.thread.assistantBubbles",
        schema: z.boolean(),
        default: false,
        description: "Show assistant replies in message bubbles, like your own messages.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.reducedMotion",
        schema: z.enum(["system", "on", "off"]),
        default: "system",
        description: "Reduce interface motion.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "ui.locale",
        // A BCP 47 tag ("fr", "en-US", "en-GB") or empty. Tags without translations fall back to en-US, then en-GB.
        schema: z
            .string()
            .regex(/^$|^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language tag such as en-GB, or empty"),
        default: "",
        description:
            "Interface language as a language tag (`fr`, `en-US`, `en-GB`). Empty follows the browser's languages and " +
            "falls back to US English (en-US). Text without a translation shows in US English, then in British " +
            "English (en-GB), the complete source language.",
        userTwin: "user",
        merge: "override",
        public: true,
    }),
    def({
        key: "system.agent.profile",
        schema: z.enum(["computer"]),
        default: "computer",
        description:
            "Tool profile of the agent. `computer` offers only the PiKVM tools and the conversation tools; no shell, file or network tool.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.pikvm.approval",
        schema: z.enum(["smart", "risky", "always", "never"]),
        default: "risky",
        description: "When the PiKVM tools ask for approval: fixed risk rules, smart screen checks plus fixed rules, every input, or never. Smart checks require approval when OCR or the Decisions model is unavailable.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.pikvm.allowPower",
        schema: z.boolean(),
        default: false,
        description: "Let the agent use the power tool (ATX on, off and reset). Each use still asks for approval.",
        userTwin: "none",
        merge: "override",
    }),
    def({
        key: "agent.pikvm.maxEdge",
        schema: z.number().int().min(320).max(4096),
        default: 1280,
        description: "Longest edge, in pixels, of the screenshots the agent sees. Click coordinates use this frame.",
        userTwin: "none",
        merge: "override",
    }),
] as const;

export type SettingKey = (typeof settingDefs)[number]["key"];

/**
 * Keys that were renamed: old key -> new key. Stored rows move at boot (server settings/migrate.ts), config.toml
 * entries are read under the new key (settings/toml.ts), and a write to an old key is refused with the new name.
 * Entries stay here so old files and old browser tabs get a clear answer.
 */
export const RENAMED_SETTING_KEYS: Readonly<Record<string, SettingKey>> = {
    "agent.titleModel": "agent.modelRoles.tiny",
    "agent.modelRoles.fast": "agent.modelRoles.smol",
};

/** The new name of a renamed key (relative to the user), or undefined. Own keys only (`constructor` is not one). */
export function renamedKey(key: string): SettingKey | undefined {
    return Object.hasOwn(RENAMED_SETTING_KEYS, key) ? RENAMED_SETTING_KEYS[key] : undefined;
}

const registry = new Map<string, SettingDef>(settingDefs.map((d) => [d.key, d as SettingDef]));

export function getDef(key: string): SettingDef | undefined {
    return registry.get(key);
}

export function allDefs(): SettingDef[] {
    return [...registry.values()];
}

// Key parsing

export type ParsedKey =
    | { kind: "global"; key: string; def: SettingDef }
    | { kind: "user"; userId: string; key: string; def: SettingDef; fullKey: string }
    | { kind: "userFree"; userId: string; key: string; fullKey: string };

export class SettingsKeyError extends Error {
    constructor(
        message: string,
        readonly code: "invalid_key" | "unknown_key" | "no_user_twin" | "partial_key",
    ) {
        super(message);
    }
}

export function userKey(userId: string, key: string): string {
    return `${USERS_PREFIX}.${userId}.${key}`;
}

/**
 * Classify a full stored key. Registered keys must be written whole: a key that is a strict prefix
 * of a registered key (`agent`) or extends one (`agent.mcp.github`) is rejected, so every value
 * has exactly one row and one schema.
 */
export function parseKey(fullKey: string): ParsedKey {
    const segments = fullKey.split(".");
    if (segments.some((s) => !SEGMENT_RE.test(s))) {
        throw new SettingsKeyError(`Invalid key: ${fullKey}`, "invalid_key");
    }
    const relative = segments[0] === USERS_PREFIX ? segments.slice(2).join(".") : fullKey;
    const renamed = renamedKey(relative);
    if (renamed) throw new SettingsKeyError(`${relative} was renamed to ${renamed}`, "unknown_key");
    if (segments[0] === USERS_PREFIX) {
        const userId = segments[1];
        const rest = segments.slice(2).join(".");
        if (!userId || !rest) throw new SettingsKeyError(`Invalid user key: ${fullKey}`, "invalid_key");
        const d = registry.get(rest);
        if (d) {
            if (d.userTwin === "none") {
                throw new SettingsKeyError(`${rest} has no per-user value`, "no_user_twin");
            }
            return { kind: "user", userId, key: rest, def: d, fullKey };
        }
        assertNotPartial(rest);
        return { kind: "userFree", userId, key: rest, fullKey };
    }
    const d = registry.get(fullKey);
    if (!d) {
        assertNotPartial(fullKey);
        throw new SettingsKeyError(`Unknown setting: ${fullKey}`, "unknown_key");
    }
    return { kind: "global", key: fullKey, def: d };
}

function assertNotPartial(key: string): void {
    for (const k of registry.keys()) {
        if (k.startsWith(`${key}.`) || key.startsWith(`${k}.`)) {
            throw new SettingsKeyError(`${key} overlaps registered setting ${k}; write ${k} whole`, "partial_key");
        }
    }
}

// Validation, merge, secrets

export function validateValue(d: SettingDef, value: unknown): unknown {
    return d.schema.parse(value);
}

export interface Resolved<T = unknown> {
    value: T;
    /** For `override`: where the value came from. */
    source: "user" | "global" | "default";
    /** For `record`: ids defined by the user that a global entry shadows. */
    shadowed?: string[];
    /** For `record`: owner of each entry. */
    owners?: Record<string, "global" | "user">;
}

export function resolve(d: SettingDef, globalValue: unknown, userValue: unknown): Resolved {
    if (d.merge === "record") {
        const g = (globalValue ?? d.default ?? {}) as Record<string, unknown>;
        const u = (userValue ?? {}) as Record<string, unknown>;
        const value: Record<string, unknown> = {};
        const owners: Record<string, "global" | "user"> = {};
        const shadowed: string[] = [];
        for (const [id, entry] of Object.entries(u)) {
            value[id] = entry;
            owners[id] = "user";
        }
        for (const [id, entry] of Object.entries(g)) {
            if (id in u) shadowed.push(id);
            value[id] = entry;
            owners[id] = "global";
        }
        return { value, source: userValue !== undefined ? "user" : globalValue !== undefined ? "global" : "default", owners, shadowed };
    }
    if (userValue !== undefined) return { value: userValue, source: "user" };
    if (globalValue !== undefined) return { value: globalValue, source: "global" };
    return { value: d.default, source: "default" };
}

function matchPath(pattern: string[], path: string[]): boolean {
    return pattern.length === path.length && pattern.every((p, i) => p === "*" || p === path[i]);
}

/** Visit every leaf of a JSON value with its path. */
function mapLeaves(value: unknown, fn: (path: string[], leaf: unknown) => unknown, path: string[] = []): unknown {
    if (Array.isArray(value)) return value.map((v, i) => mapLeaves(v, fn, [...path, String(i)]));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapLeaves(v, fn, [...path, k])]),
        );
    }
    return fn(path, value);
}

function isSecretPath(d: SettingDef, path: string[]): boolean {
    return (d.secrets ?? []).some((p) => matchPath(p.split("."), path));
}

/** Apply `fn` to every non-empty string leaf the setting declares secret (`secrets`), keeping the rest as it is. */
export function mapSecrets(d: SettingDef, value: unknown, fn: (leaf: string, path: string[]) => string): unknown {
    if (!d.secrets?.length) return value;
    return mapLeaves(value, (path, leaf) => (typeof leaf === "string" && leaf && isSecretPath(d, path) ? fn(leaf, path) : leaf));
}

/** Replace secret leaves with the mask. */
export function redact(d: SettingDef, value: unknown): unknown {
    if (!d.secrets?.length) return value;
    return mapLeaves(value, (path, leaf) => (typeof leaf === "string" && leaf && isSecretPath(d, path) ? SECRET_MASK : leaf));
}

/** Put stored secrets back where the client sent the mask, so masked values round-trip. */
export function unmask(d: SettingDef, incoming: unknown, stored: unknown): unknown {
    if (!d.secrets?.length) return incoming;
    return mapLeaves(incoming, (path, leaf) => {
        if (leaf !== SECRET_MASK || !isSecretPath(d, path)) return leaf;
        let cur: unknown = stored;
        for (const seg of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
        return typeof cur === "string" ? cur : "";
    });
}
