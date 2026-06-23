/**
 * Secrets vault. Named secrets (e.g. "Windows password") the agent can TYPE but
 * never SEE — the value is never returned to the model's context.
 *
 * Encryption at rest is pluggable via an injected `SecretCrypto`:
 *  - desktop: Electron `safeStorage` (OS keychain) — see `secret-crypto-electron.ts`
 *  - headless: an AES-256-GCM keyfile (0600) on disk — see `secret-crypto-keyfile.ts`
 * When no crypto is available (or it fails) values fall back to plaintext on disk,
 * rather than throwing (a thrown set would otherwise drop the write entirely).
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";

/**
 * Pluggable encryption backend. Both methods are sync to match the store's API;
 * `available()` gates whether we encrypt at all (false → plaintext fallback).
 */
export interface SecretCrypto {
    available(): boolean;
    /** Encrypt a UTF-8 string to bytes (caller base64-encodes for storage). */
    encrypt(value: string): Buffer;
    /** Decrypt bytes produced by `encrypt` back to a UTF-8 string. */
    decrypt(data: Buffer): string;
}

/** No-op crypto: never encrypts (everything is stored as plaintext). */
const noopCrypto: SecretCrypto = {
    available: () => false,
    encrypt: (v) => Buffer.from(v, "utf-8"),
    decrypt: (d) => d.toString("utf-8"),
};

interface Entry {
    enc?: string; // base64 of crypto-encrypted value
    plain?: string; // fallback when encryption is unavailable
    hint?: string; // non-secret guidance for the agent on when/where to use it
}

export class SecretsStore {
    private data: Record<string, Entry> = {};
    private readonly crypto: SecretCrypto;

    constructor(private readonly path: string, crypto: SecretCrypto = noopCrypto) {
        this.crypto = crypto;
        this.data = this.load();
    }

    /** Read the on-disk vault (empty object if missing/corrupt). */
    private load(): Record<string, Entry> {
        if (!existsSync(this.path)) return {};
        try {
            const parsed = JSON.parse(readFileSync(this.path, "utf-8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            return {};
        }
    }

    /**
     * Atomic write: serialize to a temp file then rename over the target, so an
     * interrupted write can never leave a truncated/unparseable vault (which would
     * look like "all my secrets vanished" on next load).
     */
    private save() {
        try {
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
            renameSync(tmp, this.path);
        } catch {
            /* best-effort */
        }
    }

    encryptionAvailable(): boolean {
        try {
            return this.crypto.available();
        } catch {
            return false;
        }
    }

    set(name: string, value: string, hint?: string): void {
        const key = name.trim();
        if (!key) return;
        // Encrypt if we can; if the backend hiccups, fall back to plaintext rather
        // than throwing (a thrown set would otherwise drop the write entirely).
        let stored: Entry;
        try {
            stored = this.encryptionAvailable() ? { enc: this.crypto.encrypt(value).toString("base64") } : { plain: value };
        } catch {
            stored = { plain: value };
        }
        const trimmedHint = hint?.trim();
        if (trimmedHint) stored.hint = trimmedHint;
        // Re-read first so a concurrent/earlier write to the same file is never lost.
        this.data = this.load();
        this.data[key] = stored;
        this.save();
    }

    /** Update only the usage hint/note, leaving the stored value untouched. */
    setHint(name: string, hint: string): void {
        const key = name.trim();
        this.data = this.load();
        const e = this.data[key];
        if (!e) return;
        const trimmed = hint.trim();
        if (trimmed) e.hint = trimmed;
        else delete e.hint;
        this.save();
    }

    /** Returns the decrypted value — used only to type it, never returned to the model. */
    get(name: string): string | undefined {
        const e = this.data[name];
        if (!e) return undefined;
        if (e.enc != null) {
            try {
                return this.crypto.decrypt(Buffer.from(e.enc, "base64"));
            } catch {
                return undefined;
            }
        }
        return e.plain;
    }

    names(): string[] {
        return Object.keys(this.data);
    }

    /** Names + non-secret usage hints — safe to show the agent and the UI. */
    list(): { name: string; hint?: string }[] {
        return Object.entries(this.data).map(([name, e]) => (e.hint ? { name, hint: e.hint } : { name }));
    }

    delete(name: string): void {
        this.data = this.load();
        delete this.data[name];
        this.save();
    }
}
