/**
 * Secrets vault. Named secrets (e.g. "Windows password") the agent can TYPE but
 * never SEE — the value is never returned to the model's context. Encrypted at
 * rest with the OS keychain via Electron safeStorage when available.
 */

import { safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "fs";

interface Entry {
    enc?: string; // base64 of safeStorage-encrypted value
    plain?: string; // fallback when encryption is unavailable
    hint?: string; // non-secret guidance for the agent on when/where to use it
}

export class SecretsStore {
    private data: Record<string, Entry> = {};

    constructor(private readonly path: string) {
        if (existsSync(path)) {
            try {
                this.data = JSON.parse(readFileSync(path, "utf-8"));
            } catch {
                /* start empty */
            }
        }
    }

    private save() {
        try {
            writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        } catch {
            /* best-effort */
        }
    }

    encryptionAvailable(): boolean {
        try {
            return safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    set(name: string, value: string, hint?: string): void {
        const key = name.trim();
        if (!key) return;
        const stored: Entry = this.encryptionAvailable()
            ? { enc: safeStorage.encryptString(value).toString("base64") }
            : { plain: value };
        const trimmedHint = hint?.trim();
        if (trimmedHint) stored.hint = trimmedHint;
        this.data[key] = stored;
        this.save();
    }

    /** Returns the decrypted value — used only to type it, never returned to the model. */
    get(name: string): string | undefined {
        const e = this.data[name];
        if (!e) return undefined;
        if (e.enc != null) {
            try {
                return safeStorage.decryptString(Buffer.from(e.enc, "base64"));
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
        delete this.data[name];
        this.save();
    }
}
