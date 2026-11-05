/**
 * The remote server this app may use (at most one), and the token that signs in to it.
 *
 * `servers.json` (in the app's user data folder) holds what is not secret: the one saved server's id, name and origin,
 * its last known state, and which one is in use (`active`: null while this computer's own server is). The access
 * tokens live only in `server-tokens.json` beside it, one entry per id, mode 0600, written through a temporary file
 * and a rename, in a folder that is 0700 when this created it. Nothing here returns, logs or throws a token.
 *
 * The address must be https, or http to a loopback host: the token and the PiKVM passwords travel to it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

/** A refusal with a message fit to show a person. It never carries a token or a password. */
export class ServerError extends Error {}

/** No saved server has that id. */
export class ServerNotFound extends ServerError {
    constructor() {
        super("There is no server with that id.");
    }
}

/** A second server may not be saved while one is. Checked before anything is probed or stored. */
export class ServerAlreadySaved extends ServerError {
    constructor() {
        super("A server is already saved. Forget it first.");
    }
}

const MAX_NAME = 80;

export type ServerState = "unchecked" | "ok" | "unreachable";

/** A saved server as a client may see it: no token, only whether one is set. */
export interface ServerView {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly tokenSet: boolean;
    readonly active: boolean;
    readonly state: ServerState;
}

export interface ServerListView {
    readonly items: readonly ServerView[];
    readonly localActive: boolean;
}

/** A server to talk to. Contains the token: never send it to a client. */
export interface RemoteServer {
    readonly origin: string;
    readonly token: string;
}

/** The server in use, with the id the forwarder reports its state under. */
export interface Connection extends RemoteServer {
    readonly id: string;
}

/** Checks a server answers the token. Throws a ServerError whose message is fit to show. */
export type Probe = (server: RemoteServer) => Promise<void>;

interface Saved {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly state: ServerState;
}

type Json = Record<string, unknown>;

/** Is this host name this machine? (`localhost`, 127.0.0.0/8, ::1) */
export function isLoopbackHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * The origin to talk to, from what a person typed. https, or http to a loopback host; no credentials in it, no
 * path. Anything else is refused with a sentence that says why, because the token and the passwords go to it.
 */
export function checkServerOrigin(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new ServerError("That is not a URL. Include the scheme, for example https://server.example/");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new ServerError("The server address must start with https://");
    }
    if (!url.hostname) throw new ServerError("The server address needs a host, for example https://server.example/");
    if (url.username || url.password) {
        throw new ServerError("Leave the user name and password out of the address. The access token is entered separately.");
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new ServerError(
            "The server address must use https://. Plain http is only accepted for this machine (localhost), " +
                "because your access token and PiKVM passwords would cross the network in the clear.",
        );
    }
    return url.origin;
}

function asState(value: unknown): ServerState {
    return value === "ok" || value === "unreachable" ? value : "unchecked";
}

export class ServerStore {
    private readonly config: string;
    private readonly tokenFile: string;
    private items: Saved[];
    private active: string | null;
    private tokens: Record<string, string>;

    constructor(dir: string) {
        this.config = resolve(dir, "servers.json");
        this.tokenFile = resolve(dir, "server-tokens.json");
        const json = this.readJson(this.config);
        this.items = [];
        const seen = new Set<string>();
        const rawItems = json?.["items"];
        for (const raw of Array.isArray(rawItems) ? rawItems : []) {
            if (typeof raw !== "object" || raw === null) continue;
            const { id, name, origin, state } = raw as Json;
            if (typeof id !== "string" || typeof name !== "string" || typeof origin !== "string" || seen.has(id)) continue;
            try {
                this.items.push({ id, name, origin: checkServerOrigin(origin), state: asState(state) });
                seen.add(id);
                // One saved server at most: a file that holds more is read as its first valid entry only.
                break;
            } catch {
                /* an address that is no longer acceptable is dropped, not used */
            }
        }
        const active = json?.["active"];
        this.active = typeof active === "string" && seen.has(active) ? active : null;
        this.tokens = {};
        for (const [id, token] of Object.entries(this.readJson(this.tokenFile) ?? {})) {
            if (typeof token === "string") this.tokens[id] = token;
        }
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

    list(): ServerListView {
        return { items: this.items.map((item) => this.view(item)), localActive: this.active === null };
    }

    /** The server in use, or null while this computer's own server is. */
    connection(): Connection | null {
        const item = this.find(this.active);
        const token = item ? this.tokens[item.id] : undefined;
        return item && token ? { id: item.id, origin: item.origin, token } : null;
    }

    /** A saved server's address and token, for the one thing besides the forwarder that needs them: telling it to forget this app
     *  when the server is removed. Never sent to a client. */
    credentials(id: string): RemoteServer | null {
        const item = this.find(id);
        const token = item ? this.tokens[item.id] : undefined;
        return item && token ? { origin: item.origin, token } : null;
    }

    /** Probe a new server with its token, then save it. Saving does not make it the one in use. */
    async add(input: { readonly name?: string | undefined; readonly origin: string; readonly token: string }, probe: Probe): Promise<ServerView> {
        if (this.items.length > 0) throw new ServerAlreadySaved();
        const origin = checkServerOrigin(input.origin);
        if (!input.token) throw new ServerError("Enter the server's access token.");
        const name = input.name?.trim() || new URL(origin).host;
        if (name.length > MAX_NAME) throw new ServerError(`The name can be at most ${MAX_NAME} characters.`);
        await probe({ origin, token: input.token });
        const item: Saved = { id: randomBytes(8).toString("hex"), name, origin, state: "ok" };
        this.items.push(item);
        this.tokens[item.id] = input.token;
        this.persist();
        return this.view(item);
    }

    /** Forget a saved server and its token. Its own settings, macros, PiKVMs and chats are not this app's to touch. */
    remove(id: string): ServerListView {
        const index = this.items.findIndex((item) => item.id === id);
        if (index < 0) throw new ServerNotFound();
        this.items.splice(index, 1);
        delete this.tokens[id];
        if (this.active === id) this.active = null;
        this.persist();
        return this.list();
    }

    /**
     * Use a saved server. It is probed first: when it answers, it becomes the one in use. When it does not, it is
     * marked unreachable, the one in use stays as it was, and the probe's refusal is thrown.
     */
    async use(id: string, probe: Probe): Promise<ServerListView> {
        const item = this.find(id);
        if (!item) throw new ServerNotFound();
        try {
            await probe({ origin: item.origin, token: this.tokens[id] ?? "" });
        } catch (error) {
            this.replace(id, "unreachable");
            this.persist();
            throw error;
        }
        this.replace(id, "ok");
        this.active = id;
        this.persist();
        return this.list();
    }

    /** This computer's own server is used again. */
    useLocal(): ServerListView {
        this.active = null;
        this.persist();
        return this.list();
    }

    /** What the forwarder saw of the server in use: a reply, or none. Only a change is written. */
    reached(id: string, ok: boolean): void {
        const item = this.find(id);
        const state: ServerState = ok ? "ok" : "unreachable";
        if (!item || item.state === state) return;
        this.replace(id, state);
        this.persist();
    }

    private find(id: string | null): Saved | undefined {
        return id === null ? undefined : this.items.find((item) => item.id === id);
    }

    private replace(id: string, state: ServerState): void {
        this.items = this.items.map((item) => (item.id === id ? { ...item, state } : item));
    }

    private view(item: Saved): ServerView {
        return {
            id: item.id,
            name: item.name,
            origin: item.origin,
            tokenSet: Boolean(this.tokens[item.id]),
            active: item.id === this.active,
            state: item.state,
        };
    }

    private persist(): void {
        // Tokens of entries no longer saved (a hand-edited file may have held more) are dropped with the write.
        for (const id of Object.keys(this.tokens)) if (!this.find(id)) delete this.tokens[id];
        this.writeAtomic(this.config, JSON.stringify({ version: 1, active: this.active, items: this.items }, null, 2));
        this.writeAtomic(this.tokenFile, JSON.stringify(this.tokens));
    }

    /** Temporary file in the same folder, then a rename, so a crash leaves the old file or the new one. */
    private writeAtomic(path: string, text: string): void {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, text, { mode: 0o600 });
        // writeFileSync's mode is masked by the umask and ignored for an existing file.
        chmodSync(temp, 0o600);
        renameSync(temp, path);
    }
}
