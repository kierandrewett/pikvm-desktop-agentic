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
