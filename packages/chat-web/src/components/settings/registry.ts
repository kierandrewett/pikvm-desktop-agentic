/**
 * Settings registry: the categories and rows of the four Chat settings pages, as data.
 *
 * Pages read a row's label and description with `row(id)`; KeyRow and the other bound rows look them up by id.
 * A row that edits a setting key uses the key as its id (`agent.permission`), or the key plus a field for object
 * values (`agent.compaction.enabled`). The id is also the deep-link anchor: `#<id>` scrolls to the row.
 *
 * Keep it data only (no React, no icons). The English text is the source; the Fluent resolver below swaps it for
 * the message `settingsMessageId()` names, and a missing message falls back to the English.
 */

export type SettingsGroup = "chat";

export interface SettingsRowDef {
    id: string;
    label: string;
    /** Shown under the label. */
    description?: string;
    /** Section heading the row sits under. */
    section?: string;
}

export interface SettingsCategoryDef {
    slug: string;
    label: string;
    description: string;
    rows: readonly SettingsRowDef[];
}

export const groupLabels: Record<SettingsGroup, string> = {
    get chat() {
        return resolveText(settingsMessageId("group", "chat"), "Chat");
    },
};

const rawCategories: readonly SettingsCategoryDef[] = [
    {
        slug: "models",
        label: "Models",
        description: "The model new chats start with, and the models for side work.",
        rows: [
            {
                id: "agent.defaultModel",
                label: "Default model",
                description: "The model new chats start with.",
                section: "Models",
            },
            {
                id: "agent.defaultThinking",
                label: "Reasoning effort",
                description: "How much new chats think before answering.",
                section: "Models",
            },
            {
                id: "agent.modelRoles.smol",
                label: "Fast model",
                description: "A quick model for light side work.",
                section: "Models",
            },
            {
                id: "agent.modelRoles.slow",
                label: "Thinking model",
                description: "A strong model for thorough side work.",
                section: "Models",
            },
            {
                id: "agent.modelRoles.tiny",
                label: "Small tasks model",
                description: "Writes chat titles.",
                section: "Advanced",
            },
            {
                id: "agent.titleGeneration",
                label: "Generate titles",
                description: "Name new chats from the first message.",
                section: "Advanced",
            },
        ],
    },
    {
        slug: "providers",
        label: "Model providers",
        description: "Connect model providers with your own keys.",
        rows: [{ id: "providers", label: "Your providers", description: "" }],
    },
    {
        slug: "mcp",
        label: "MCP servers",
        description: "Give the assistant tools from MCP servers.",
        rows: [
            { id: "mcp", label: "Your MCP servers", description: "" },
            {
                id: "agent.mcpApprovals.trustReadOnly",
                label: "Trust read-only tool annotations",
                description: "Skip approval for tools their server marks read-only.",
                section: "Tool approvals",
            },
            {
                id: "agent.mcpApprovals.confirmDestructive",
                label: "Confirm destructive tools",
                description: "Ask before tools marked destructive run.",
                section: "Tool approvals",
            },
        ],
    },
    {
        slug: "agent",
        label: "Agent",
        description: "How the assistant works the PiKVM, and when it asks first.",
        rows: [
            {
                id: "agent.pikvm.approval",
                label: "Ask before PiKVM actions",
                description: "Risky actions only, every input, or never.",
                section: "PiKVM",
            },
            {
                id: "agent.pikvm.allowPower",
                label: "Allow power control",
                description: "Let the assistant switch the machine on, off or reset it. Each use still asks.",
                section: "PiKVM",
            },
            {
                id: "agent.pikvm.maxEdge",
                label: "Screenshot size",
                description: "The longest edge, in pixels, of the screenshots the assistant sees.",
                section: "PiKVM",
            },
            {
                id: "agent.permission",
                label: "Permissions",
                description: "Whether the assistant asks before acting.",
                section: "Permissions",
            },
            {
                id: "agent.memory.enabled",
                label: "Memory",
                description: "Remember facts across your chats. Kept only in your own private store.",
                section: "Agent runtime",
            },
            {
                id: "agent.askTimeoutSec",
                label: "Question timeout",
                description: "How long the assistant waits for an answer.",
                section: "Agent runtime",
            },
            {
                id: "agent.instructions",
                label: "Custom instructions",
                description: "Extra instructions added to every chat.",
                section: "Agent runtime",
            },
            {
                id: "agent.compaction.enabled",
                label: "Summarize long chats",
                description: "Summarize earlier messages when a chat fills up.",
                section: "Agent runtime",
            },
            {
                id: "agent.compaction.thresholdPercent",
                label: "Summarize at",
                description: "How full a chat gets before it is summarized.",
                section: "Agent runtime",
            },
        ],
    },
];

// Localised text. The data above is the English source. `categories` and `groupLabels` expose label, description and
// section as getters that ask the resolver for the message `settingsMessageId()` names, and fall back to the English
// text. The app sets the resolver (l10n/registry-text.ts); scripts that import this file get the English text.
// `scripts/gen-settings-l10n.ts` writes en-GB/settings-rows.ftl from this data, `just lint-l10n` checks it is current.

export type SettingsTextResolver = (id: string, english: string) => string;
let resolveText: SettingsTextResolver = (_id, english) => english;
export function setSettingsTextResolver(resolver: SettingsTextResolver): void {
    resolveText = resolver;
}

const kebab = (text: string): string =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

export type SettingsMessageKind =
    "group" | "category-label" | "category-description" | "row-label" | "row-description" | "section";

/** Message ID for a piece of registry text. `key` is a group, a slug, a row id or the section's English text. */
export function settingsMessageId(kind: SettingsMessageKind, key: string): string {
    const k = kebab(key);
    switch (kind) {
        case "group":
            return `settings-group-${k}`;
        case "section":
            return `settings-section-${k}`;
        case "category-label":
            return `settings-cat-${k}-label`;
        case "category-description":
            return `settings-cat-${k}-description`;
        case "row-label":
            return `settings-row-${k}-label`;
        case "row-description":
            return `settings-row-${k}-description`;
    }
}

function localised<T extends object>(source: T, fields: [keyof T & string, string, string | undefined][]): T {
    const out = { ...source };
    for (const [field, id, english] of fields) {
        if (!english) continue;
        Object.defineProperty(out, field, {
            get: () => resolveText(id, english),
            enumerable: true,
            configurable: true,
        });
    }
    return out;
}

function localiseRow(r: SettingsRowDef): SettingsRowDef {
    return localised(r, [
        ["label", settingsMessageId("row-label", r.id), r.label],
        ["description", settingsMessageId("row-description", r.id), r.description],
        ["section", settingsMessageId("section", r.section ?? ""), r.section],
    ]);
}

export const categories: readonly SettingsCategoryDef[] = rawCategories.map((c) => ({
    ...localised(c, [
        ["label", settingsMessageId("category-label", c.slug), c.label],
        ["description", settingsMessageId("category-description", c.slug), c.description],
    ]),
    rows: c.rows.map(localiseRow),
}));

/** The English source, for the generator and the checks. */
export const sourceCategories = rawCategories;

const bySlug = new Map(categories.map((c) => [c.slug, c]));
const byId = new Map<string, { row: SettingsRowDef; category: SettingsCategoryDef }>();
for (const category of categories) {
    for (const r of category.rows) {
        byId.set(r.id, { row: r, category });
    }
}

export const findCategory = (slug: string): SettingsCategoryDef | undefined => bySlug.get(slug);

/** Ignore malformed hash escapes rather than interrupting settings rendering. */
export function settingsAnchor(): string {
    try {
        return decodeURIComponent(location.hash.slice(1));
    } catch {
        return "";
    }
}

/** Row and owning category for an id or alias. */
export const findRow = (id: string) => byId.get(id);

/** Label and description of a row, for pages: `<SettingRow {...row("password")} control={...} />`. */
export function row(id: string): { id: string; label: string; description?: string } {
    const r = byId.get(id)?.row;
    if (!r) {
        if (import.meta.env?.DEV) console.warn(`[settings] row ${id} is not in registry.ts`);
        return { id, label: id };
    }
    return { id: r.id, label: r.label, description: r.description || undefined };
}
