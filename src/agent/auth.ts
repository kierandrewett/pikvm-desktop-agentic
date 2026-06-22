/**
 * ChatGPT-subscription auth for the embedded Pi agent.
 *
 * Uses pi-ai's OpenAI Codex OAuth — the same flow (and the same ChatGPT
 * Plus/Pro subscription) the Codex CLI uses, so requests bill against the
 * subscription rather than a per-token API key.
 *
 * Credentials are persisted in the app's userData. On first run we can also
 * seed from an existing `~/.codex/auth.json` so the user doesn't have to log in
 * again.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import {
    openaiCodexOAuthProvider,
    refreshOpenAICodexToken,
    loginOpenAICodex,
} from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials, OAuthPrompt } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { PROVIDERS, getProviderInfoByPi, type ProviderInfo } from "./providers";
import type { SecretsStore } from "../secrets";

export interface LoginUi {
    /** Called with the URL to open in the browser for the OAuth consent. */
    onAuth: (info: { url: string; instructions?: string }) => void;
    /** Prompt the user to paste a code (fallback if the callback server misses). */
    onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
}

/** Decode a JWT's `exp` (seconds) without verifying. */
function jwtExpiry(token: string): number | undefined {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
        return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
    } catch {
        return undefined;
    }
}

export class CodexAuth {
    private creds: OAuthCredentials | undefined;

    constructor(private readonly credentialsPath: string) {}

    /** Load persisted credentials, falling back to seeding from ~/.codex/auth.json. */
    load(): boolean {
        if (existsSync(this.credentialsPath)) {
            try {
                this.creds = JSON.parse(readFileSync(this.credentialsPath, "utf-8"));
                return true;
            } catch {
                /* fall through */
            }
        }
        return this.seedFromCodexCli();
    }

    private seedFromCodexCli(): boolean {
        const codexAuth = resolve(homedir(), ".codex", "auth.json");
        if (!existsSync(codexAuth)) return false;
        try {
            const raw = JSON.parse(readFileSync(codexAuth, "utf-8"));
            const tokens = raw.tokens ?? raw;
            const access = tokens.access_token;
            const refresh = tokens.refresh_token;
            if (!access || !refresh) return false;
            this.creds = {
                access,
                refresh,
                // Force a refresh on first use if we can't read an expiry.
                expires: jwtExpiry(access) ?? 0,
                ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
            };
            this.persist();
            return true;
        } catch {
            return false;
        }
    }

    private persist(): void {
        if (this.creds) writeFileSync(this.credentialsPath, JSON.stringify(this.creds, null, 2), { mode: 0o600 });
    }

    isLoggedIn(): boolean {
        return !!this.creds;
    }

    /** Run the browser OAuth flow and persist the resulting credentials. */
    async login(ui: LoginUi): Promise<void> {
        this.creds = await loginOpenAICodex({
            onAuth: ui.onAuth,
            onPrompt: ui.onPrompt ?? (async () => ""),
            ...(ui.onProgress ? { onProgress: ui.onProgress } : {}),
        });
        this.persist();
    }

    /** Return a valid bearer token, refreshing if it's expired or near-expiry. */
    async getToken(): Promise<string> {
        if (!this.creds) throw new Error("Not signed in to ChatGPT.");
        const skewMs = 60_000;
        if (!this.creds.expires || Date.now() > this.creds.expires - skewMs) {
            this.creds = await refreshOpenAICodexToken(this.creds.refresh);
            this.persist();
        }
        return openaiCodexOAuthProvider.getApiKey(this.creds);
    }

    /** Apply provider-specific model tweaks (base URL / account headers). */
    applyModel<T extends Model<any>>(model: T): T {
        if (!this.creds || !openaiCodexOAuthProvider.modifyModels) return model;
        const [m] = openaiCodexOAuthProvider.modifyModels([model], this.creds);
        return (m as T) ?? model;
    }
}

/* ------------------------------------------------------------------------- *
 *  Multi-provider auth registry
 *
 *  Generalises the single-provider `CodexAuth` into a registry keyed by our
 *  provider id. `codex` stays an OAuth provider (the ChatGPT subscription);
 *  every other provider is API-key based, with the key read from the secrets
 *  vault (never plaintext settings).
 *
 *  How a key reaches a request: pi-ai's stream resolves the API key by calling
 *  the Agent's `getApiKey(piProvider)` callback (it is passed the model's pi-ai
 *  provider id — see agent-loop.js), falling back to the provider's env var. We
 *  satisfy BOTH paths: `keyForPiProvider()` answers the callback, and
 *  `applyEnv()` also exports the env var as a belt-and-braces fallback for any
 *  pi-ai code path that reads the environment directly.
 * ------------------------------------------------------------------------- */

/** A provider's auth state for the settings UI. */
export interface ProviderAuthStatus {
    id: string;
    label: string;
    kind: ProviderInfo["kind"];
    /** OAuth: signed in. API key: a key is stored. */
    ready: boolean;
    /** Where to get a key (API-key providers only). */
    keyHint?: string;
}

export class ProviderAuthRegistry {
    /**
     * @param codex   the existing ChatGPT-subscription OAuth provider.
     * @param secrets the vault API-key providers read/write their keys through.
     */
    constructor(
        private readonly codex: CodexAuth,
        private readonly secrets: SecretsStore | undefined,
    ) {
        this.applyEnv();
    }

    /** Secrets-vault key under which a provider's API key lives. */
    private static secretName(providerId: string): string {
        return `provider_key_${providerId}`;
    }

    /** Store (or clear) an API key for a provider, in the secrets vault. */
    setKey(providerId: string, key: string): boolean {
        const info = PROVIDERS.find((p) => p.id === providerId);
        if (!info || info.kind !== "apiKey" || !this.secrets) return false;
        const name = ProviderAuthRegistry.secretName(providerId);
        const trimmed = key.trim();
        if (trimmed) this.secrets.set(name, trimmed, `API key for ${info.label} (model provider)`);
        else this.secrets.delete(name);
        this.applyEnv();
        return true;
    }

    /** The stored API key for a provider, or undefined. (Never sent to the model context.) */
    private storedKey(providerId: string): string | undefined {
        if (!this.secrets) return undefined;
        return this.secrets.get(ProviderAuthRegistry.secretName(providerId));
    }

    /** Whether a provider is usable right now (OAuth signed in, or a key stored). */
    isReady(providerId: string): boolean {
        const info = PROVIDERS.find((p) => p.id === providerId);
        if (!info) return false;
        if (info.kind === "oauth") return this.codex.isLoggedIn();
        return !!this.storedKey(providerId);
    }

    /** Status of every provider, for the settings panel. */
    status(): ProviderAuthStatus[] {
        return PROVIDERS.map((p) => ({
            id: p.id,
            label: p.label,
            kind: p.kind,
            ready: this.isReady(p.id),
            ...(p.keyHint ? { keyHint: p.keyHint } : {}),
        }));
    }

    /**
     * Export every stored API key to its provider's env var, so pi-ai code paths
     * that read the environment (rather than the `getApiKey` callback) also work.
     * Called on construction and after any key change.
     */
    applyEnv(): void {
        for (const p of PROVIDERS) {
            if (p.kind !== "apiKey" || !p.envVar) continue;
            const key = this.storedKey(p.id);
            if (key) process.env[p.envVar] = key;
            else if (process.env[p.envVar]) delete process.env[p.envVar];
        }
    }

    /**
     * Resolve the API key for a pi-ai provider id (what pi-ai's `getApiKey`
     * callback is handed). For `codex` this is the refreshed OAuth bearer; for an
     * API-key provider it's the stored key. Returns undefined when not configured
     * (the request then fails clearly rather than silently using a wrong key).
     */
    async keyForPiProvider(piProvider: string): Promise<string | undefined> {
        const info = getProviderInfoByPi(piProvider);
        if (!info) {
            // Unknown provider: fall back to the codex token only if pi asked for
            // the codex provider under a different alias; otherwise nothing.
            return undefined;
        }
        if (info.kind === "oauth") {
            try {
                return await this.codex.getToken();
            } catch {
                return undefined;
            }
        }
        return this.storedKey(info.id);
    }

    /** Apply OAuth model tweaks (base URL / headers) for the codex provider only;
     *  API-key providers carry their own baseUrl in the catalogue, so pass through. */
    applyModel<T extends Model<any>>(piProvider: string, model: T): T {
        if (piProvider === "openai-codex") return this.codex.applyModel(model);
        return model;
    }
}
