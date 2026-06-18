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

    set(name: string, value: string): void {
        const key = name.trim();
        if (!key) return;
        if (this.encryptionAvailable()) {
            this.data[key] = { enc: safeStorage.encryptString(value).toString("base64") };
        } else {
            this.data[key] = { plain: value };
        }
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

    delete(name: string): void {
        delete this.data[name];
        this.save();
    }
}
