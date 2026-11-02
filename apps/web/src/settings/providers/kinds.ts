/**
 * What the form asks for, per provider kind. The server validates every combination again
 * (`ProviderConnectionRequest`); this table only decides which fields to offer, so a user is
 * not shown a base URL for a CLI or a key for a provider that signs in.
 */

export type AuthMode = "api_key" | "bearer_env" | "bearer_command";

export interface KindForm {
    readonly label: string;
    /** "key": needs an API key (unless the chosen auth mode is a command). "account": signs in with a CLI. */
    readonly family: "key" | "account";
    readonly baseUrl: "none" | "optional" | "required";
    readonly authModes?: ReadonlyArray<AuthMode>;
    readonly aliasHint: string;
    readonly modelHint: string;
}

export const KIND_FORMS: Readonly<Record<string, KindForm>> = {
    openai_responses: { label: "OpenAI", family: "key", baseUrl: "optional", aliasHint: "openai", modelHint: "gpt-5-mini" },
    anthropic_api: { label: "Anthropic", family: "key", baseUrl: "optional", aliasHint: "anthropic", modelHint: "claude-opus-4-8" },
    gemini_api: { label: "Google Gemini API", family: "key", baseUrl: "optional", aliasHint: "gemini-api", modelHint: "gemini-2.5-pro" },
    openai_compatible: {
        label: "OpenAI-compatible gateway",
        family: "key",
        baseUrl: "required",
        aliasHint: "gateway",
        modelHint: "model-name",
    },
    azure_openai_responses: {
        label: "Azure OpenAI",
        family: "key",
        baseUrl: "required",
        authModes: ["api_key", "bearer_env", "bearer_command"],
        aliasHint: "azure",
        modelHint: "deployment-name",
    },
    vertex_gemini: {
        label: "Vertex AI Gemini",
        family: "key",
        baseUrl: "required",
        authModes: ["bearer_env", "bearer_command"],
        aliasHint: "vertex",
        modelHint: "gemini-2.5-pro",
    },
    claude_cli: { label: "Claude Code", family: "account", baseUrl: "none", aliasHint: "claude", modelHint: "sonnet" },
    codex_cli: { label: "Codex CLI", family: "account", baseUrl: "none", aliasHint: "codex", modelHint: "account-default" },
    codex_app_server: { label: "Codex app server", family: "account", baseUrl: "none", aliasHint: "codex-app", modelHint: "account-default" },
    gemini_cli: { label: "Gemini CLI", family: "account", baseUrl: "none", aliasHint: "gemini", modelHint: "account-default" },
};

export const AUTH_MODE_LABEL: Readonly<Record<AuthMode, string>> = {
    api_key: "API key",
    bearer_env: "Access token",
    bearer_command: "Cloud CLI sign-in (az or gcloud)",
};

export const kindLabel = (kind: string): string => KIND_FORMS[kind]?.label ?? kind;

/** Does this combination take a key the user pastes here? */
export const takesKey = (kind: string, authMode: AuthMode | undefined): boolean =>
    KIND_FORMS[kind]?.family === "key" && authMode !== "bearer_command";
