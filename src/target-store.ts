/**
 * Where the desktop app's PiKVM is, and how to sign in to it.
 *
 * `pikvm.json` (in the app's user data folder) holds what is not secret: the origin and the user
 * name. The password lives in `pikvm-credentials.json` beside it, mode 0600, written through a
 * temporary file and a rename, in a folder that is 0700 when this created it. Nothing here ever returns, logs or throws the password.
 *
 * Installs from before this existed keep the user name and password inside the origin
 * (`https://user:pass@pikvm/`). They are still read, so nothing breaks, and reading never rewrites
 * the file: the credentials move to their own file only when the user saves from Settings.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_ORIGIN = "https://pikvm/";

/** What the rest of the app connects with. Contains the password: never send it to a client. */
export interface ResolvedTarget {
    readonly origin: string;
    readonly username: string;
    readonly password: string;
}

/** What a client may see. */
export interface TargetView {
    readonly origin: string;
    readonly username: string;
    readonly passwordSet: boolean;
}

/** A change from Settings. `password`: undefined keeps it, "" removes it, anything else replaces it. */
export interface TargetChange {
    readonly origin?: string | undefined;
    readonly username?: string | undefined;
    readonly password?: string | undefined;
}

/** A refusal with a message fit to show a person. */
export class TargetError extends Error {}

type Json = Record<string, unknown>;

interface Parsed {
    readonly origin: string;
    readonly username: string;
    readonly password: string;
}

/** Split a URL into its origin (with a trailing slash) and the credentials typed into it. */
function parseOrigin(raw: string): Parsed {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new TargetError("That is not a URL. Include the scheme, for example https://pikvm/");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TargetError("The address must start with http:// or https://");
    }
    if (!url.hostname) throw new TargetError("The address needs a host, for example https://pikvm/");
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { origin: url.href.endsWith("/") ? url.href : `${url.href}/`, username, password };
}

export class TargetStore {
    private readonly config: string;
    private readonly credentials: string;

    constructor(dir: string) {
        this.config = resolve(dir, "pikvm.json");
        this.credentials = resolve(dir, "pikvm-credentials.json");
    }

    private readJson(path: string): Json | null {
        if (!existsSync(path)) return null;
        try {
            const value: unknown = JSON.parse(readFileSync(path, "utf8"));
            return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
        } catch {
            return null;
        }
    }

    /** The password from its own file. A damaged file is no password, not a crash. */
    private storedPassword(): string {
        const value = this.readJson(this.credentials)?.["password"];
        return typeof value === "string" ? value : "";
    }

    /** Everything needed to connect: the file's values, with legacy embedded credentials as the fallback. */
    resolve(): ResolvedTarget {
        const json = this.readJson(this.config);
        const raw = typeof json?.["origin"] === "string" ? json["origin"] : DEFAULT_ORIGIN;
        let parsed: Parsed;
        try {
            parsed = parseOrigin(raw);
        } catch {
            parsed = parseOrigin(DEFAULT_ORIGIN);
        }
        const username = typeof json?.["username"] === "string" ? json["username"] : parsed.username;
        return { origin: parsed.origin, username, password: this.storedPassword() || parsed.password };
    }

    view(): TargetView {
        const { origin, username, password } = this.resolve();
        return { origin, username, passwordSet: password !== "" };
    }

    /** Validate, write, and return what to connect with. Nothing is written if anything is refused. */
    save(change: TargetChange): ResolvedTarget {
        const current = this.resolve();
        let { origin, username } = current;
        let password: string | undefined = change.password;
        if (change.origin !== undefined) {
            const parsed = parseOrigin(change.origin);
            origin = parsed.origin;
            // Credentials typed into the address are what the old window took; they count as typed fields.
            if (parsed.username && change.username === undefined) username = parsed.username;
            if (parsed.password && password === undefined) password = parsed.password;
        }
        if (change.username !== undefined) username = change.username.trim();
        // Not given: keep what the connection uses now, which also moves a legacy embedded password.
        const nextPassword = password ?? current.password;

        const json = this.readJson(this.config) ?? {};
        const next: Json = { ...json, origin };
        if (username) next["username"] = username;
        else delete next["username"];

        this.writeAtomic(this.config, JSON.stringify(next, null, 2), 0o600);
        if (nextPassword) this.writeAtomic(this.credentials, JSON.stringify({ password: nextPassword }), 0o600);
        else rmSync(this.credentials, { force: true });
        return { origin, username, password: nextPassword };
    }

    /** Temporary file in the same folder, then a rename, so a crash leaves the old file or the new one. */
    private writeAtomic(path: string, text: string, mode: number): void {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, text, { mode });
        // writeFileSync's mode is masked by the umask and ignored for an existing file.
        chmodSync(temp, mode);
        renameSync(temp, path);
    }
}
