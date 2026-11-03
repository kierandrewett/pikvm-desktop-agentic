/**
 * Server secret for signing cookies, auth tokens and gateway tokens. Created on first boot in the
 * data directory, never stored in settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../paths.ts";

let cached: string | undefined;

export function serverSecret(): string {
    if (cached) return cached;
    if (existsSync(paths.secretKey)) {
        cached = readFileSync(paths.secretKey, "utf8").trim();
        return cached;
    }
    mkdirSync(paths.dataDir, { recursive: true });
    cached = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    writeFileSync(paths.secretKey, `${cached}\n`, { mode: 0o600 });
    console.log(`[auth] generated server secret at ${paths.secretKey}`);
    return cached;
}
