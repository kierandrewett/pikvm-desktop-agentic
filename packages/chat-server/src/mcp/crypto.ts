/**
 * Encryption at rest for MCP credentials (OAuth tokens, client secrets).
 *
 * AES-256-GCM with a key derived from the server secret (HKDF-SHA256, info `chat:mcp-credentials:v1`). Every value
 * is sealed with additional authenticated data that names its owner (for example `user:<id>|server:<id>|...`), so a
 * ciphertext copied into another user's row fails to open instead of leaking a token across users.
 *
 * Format: `v1.<iv>.<ciphertext+tag>`, both base64url. Rotating secret.key makes every stored value unreadable; the
 * credential code treats that as "not connected" and the user signs in again.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { serverSecret } from "../auth/secret.ts";

let key: Buffer | undefined;
let keyFor: string | undefined;

function currentKey(): Buffer {
    const secret = serverSecret();
    if (!key || keyFor !== secret) {
        key = Buffer.from(hkdfSync("sha256", secret, "chat-mcp", "chat:mcp-credentials:v1", 32));
        keyFor = secret;
    }
    return key;
}

export function seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", currentKey(), iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
    return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** The plain text, or undefined when the value is not ours, was tampered with, or belongs to another owner. */
export function open(sealed: string | null | undefined, aad: string): string | undefined {
    if (!sealed) return undefined;
    const [v, ivPart, bodyPart] = sealed.split(".");
    if (v !== "v1" || !ivPart || !bodyPart) return undefined;
    try {
        const body = Buffer.from(bodyPart, "base64url");
        const d = createDecipheriv("aes-256-gcm", currentKey(), Buffer.from(ivPart, "base64url"));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(body.subarray(body.length - 16));
        return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
    } catch {
        return undefined;
    }
}
