/**
 * Keyfile-backed `SecretCrypto` for the headless server (no OS keychain).
 *
 * A random 256-bit key is generated once and stored at `keyPath` with 0600
 * permissions; secrets are sealed with AES-256-GCM (random 12-byte IV per value,
 * 16-byte auth tag). The on-disk envelope is `iv || tag || ciphertext`.
 *
 * This is NOT as strong as an OS keychain — anyone who can read the keyfile can
 * decrypt the vault — so the keyfile must be protected by filesystem permissions
 * (the homelab host's user account). It is, however, far better than the
 * plaintext fallback, and means a stolen `agent-secrets.json` alone is useless.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import type { SecretCrypto } from "./secrets";

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;

function loadOrCreateKey(keyPath: string): Buffer {
    if (existsSync(keyPath)) {
        const key = readFileSync(keyPath);
        if (key.length === KEY_LEN) return key;
        // Wrong length (corrupt/legacy) — regenerate rather than fail hard.
    }
    const key = randomBytes(KEY_LEN);
    writeFileSync(keyPath, key, { mode: 0o600 });
    try {
        chmodSync(keyPath, 0o600);
    } catch {
        /* best-effort on platforms without POSIX modes */
    }
    return key;
}

/**
 * Build a keyfile-backed crypto. The key is read/created eagerly so a missing or
 * unwritable keyfile surfaces at startup, not on first secret use.
 */
export function keyfileSecretCrypto(keyPath: string): SecretCrypto {
    const key = loadOrCreateKey(keyPath);
    return {
        available: () => true,
        encrypt(value) {
            const iv = randomBytes(IV_LEN);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            const ct = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            return Buffer.concat([iv, tag, ct]);
        },
        decrypt(data) {
            const iv = data.subarray(0, IV_LEN);
            const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
            const ct = data.subarray(IV_LEN + TAG_LEN);
            const decipher = createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
        },
    };
}
