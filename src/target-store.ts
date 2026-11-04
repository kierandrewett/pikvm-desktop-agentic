/**
 * The PiKVMs the desktop app can talk to, and how to sign in to each.
 *
 * `pikvms.json` (in the app's user data folder) holds what is not secret: for every PiKVM its id, name, origin and
 * user name, which one is the default and which one is active. The passwords live in `pikvms-credentials.json`
 * beside it, one entry per id, mode 0600, written through a temporary file and a rename, in a folder that is 0700
 * when this created it. Nothing here ever returns, logs or throws a password.
 *
 * The first PiKVM added becomes the default and the active one. Exactly one is active at a time; the proxy, the
 * agent and the screen watch follow it. Changing the active PiKVM, or any field of it, tells the subscribers so the
 * control core can re-resolve without a restart.
 *
 * Installs from before this existed have one PiKVM in `pikvm.json` (address + user name) and its password in
 * `pikvm-credentials.json`, or the user name and password inside the address (`https://user:pass@pikvm/`). Those are
 * read as one entry and reading never rewrites anything: the first change made from Settings writes the new files,
 * then removes the old credentials file and the credentials embedded in `pikvm.json`'s address. Nothing else in
 * `pikvm.json` is touched (`consoleOrigin` lives there).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

export const DEFAULT_ORIGIN = "https://pikvm/";

/** The id the PiKVM of an install from before the list existed gets. */
export const LEGACY_ID = "primary";

const MAX_NAME = 80;
const MAX_ID = 64;
const MAX_PIKVMS = 50;

/** What the rest of the app connects with. Contains the password: never send it to a client. */
export interface ResolvedTarget {
    readonly origin: string;
    readonly username: string;
    readonly password: string;
}

/** What a client may see of the active PiKVM. */
export interface TargetView {
    readonly origin: string;
    readonly username: string;
    readonly passwordSet: boolean;
}

/** A change to the active PiKVM. `password`: undefined keeps it, "" removes it, anything else replaces it. */
export interface TargetChange {
    readonly origin?: string | undefined;
    readonly username?: string | undefined;
    readonly password?: string | undefined;
}

/** One stored PiKVM as a client may see it. */
export interface PikvmView {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly username: string;
    readonly passwordSet: boolean;
    readonly isDefault: boolean;
    readonly active: boolean;
}

export interface PikvmAddInput {
    readonly name: string;
    readonly origin: string;
    readonly username?: string | undefined;
    readonly password?: string | undefined;
}

/** A change to one PiKVM. `password`: undefined keeps it, "" removes it, anything else replaces it. */
export interface PikvmPatchInput {
    readonly name?: string | undefined;
    readonly origin?: string | undefined;
    readonly username?: string | undefined;
    readonly password?: string | undefined;
}

/** A refusal with a message fit to show a person. */
export class TargetError extends Error {}

/** No PiKVM has that id. */
export class TargetNotFound extends TargetError {
    constructor() {
        super("There is no PiKVM with that id.");
    }
}

type Json = Record<string, unknown>;

interface Parsed {
    readonly origin: string;
    readonly username: string;
    readonly password: string;
}

/** The non-secret part of one stored PiKVM. */
interface Stored {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly username: string;
}

/** Everything stored, with the passwords held apart so a view can never pick one up by accident. */
interface State {
    readonly items: readonly Stored[];
    readonly defaultId: string | null;
    readonly activeId: string | null;
    readonly passwords: Readonly<Record<string, string>>;
    /** Read from the files of an install from before the list: nothing has been written yet. */
    readonly legacy: boolean;
}

const EMPTY: State = { items: [], defaultId: null, activeId: null, passwords: {}, legacy: false };

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

function cleanName(raw: string): string {
    const name = raw.trim();
    if (!name) throw new TargetError("Give the PiKVM a name.");
    if (name.length > MAX_NAME) throw new TargetError(`The name is longer than ${MAX_NAME} characters.`);
    return name;
}

/** A name for a PiKVM nobody named: the host of its address. */
function nameFromOrigin(origin: string): string {
    try {
        return new URL(origin).host.slice(0, MAX_NAME) || "PiKVM";
    } catch {
        return "PiKVM";
    }
}

export class TargetStore {
    private readonly legacyConfig: string;
    private readonly legacyCredentials: string;
    private readonly list: string;
    private readonly credentials: string;
    private readonly listeners = new Set<(target: ResolvedTarget) => void>();

    constructor(dir: string) {
        this.legacyConfig = resolve(dir, "pikvm.json");
        this.legacyCredentials = resolve(dir, "pikvm-credentials.json");
        this.list = resolve(dir, "pikvms.json");
        this.credentials = resolve(dir, "pikvms-credentials.json");
    }

    /** Be told whenever what the active PiKVM resolves to changes (a different one, or a field of it). */
    subscribe(listener: (target: ResolvedTarget) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // ---- reading ------------------------------------------------------------------------------

    private readJson(path: string): Json | null {
        if (!existsSync(path)) return null;
        try {
            const value: unknown = JSON.parse(readFileSync(path, "utf8"));
            return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
        } catch {
            return null;
        }
    }

    private read(): State {
        if (existsSync(this.list)) return this.readList();
        return this.readLegacy();
    }

    /** `pikvms.json` and its credentials file. A damaged file is an empty list or no password, not a crash. */
    private readList(): State {
        const json = this.readJson(this.list);
        const rawItems = Array.isArray(json?.["items"]) ? (json["items"] as unknown[]) : [];
        const items: Stored[] = [];
        let flaggedDefault: string | null = null;
        for (const raw of rawItems) {
            if (typeof raw !== "object" || raw === null) continue;
            const r = raw as Json;
            const id = r["id"];
            const name = r["name"];
            const origin = r["origin"];
            if (typeof id !== "string" || !id || typeof name !== "string" || typeof origin !== "string") continue;
            if (items.some((i) => i.id === id)) continue;
            let parsed: Parsed;
            try {
                parsed = parseOrigin(origin);
            } catch {
                continue;
            }
            items.push({ id, name, origin: parsed.origin, username: typeof r["username"] === "string" ? r["username"] : "" });
            if (r["isDefault"] === true && flaggedDefault === null) flaggedDefault = id;
        }
        const passwords: Record<string, string> = {};
        const stored = this.readJson(this.credentials);
        for (const item of items) {
            const value = stored?.[item.id];
            if (typeof value === "string" && value) passwords[item.id] = value;
        }
        const first = items[0]?.id ?? null;
        const defaultId = flaggedDefault ?? first;
        const wanted = json?.["active"];
        const activeId = typeof wanted === "string" && items.some((i) => i.id === wanted) ? wanted : defaultId;
        return { items, defaultId, activeId, passwords, legacy: false };
    }

    /**
     * The single PiKVM of an install from before the list, as one entry. Only a PiKVM someone set up counts:
     * the untouched default address with no user name and no password is what an empty list already means.
     */
    private readLegacy(): State {
        const json = this.readJson(this.legacyConfig);
        const raw = typeof json?.["origin"] === "string" ? json["origin"] : DEFAULT_ORIGIN;
        let parsed: Parsed;
        try {
            parsed = parseOrigin(raw);
        } catch {
            parsed = parseOrigin(DEFAULT_ORIGIN);
        }
        const username = typeof json?.["username"] === "string" ? json["username"] : parsed.username;
        const stored = this.readJson(this.legacyCredentials)?.["password"];
        const password = (typeof stored === "string" ? stored : "") || parsed.password;
        if (parsed.origin === DEFAULT_ORIGIN && !username && !password) return EMPTY;
        const item: Stored = { id: LEGACY_ID, name: nameFromOrigin(parsed.origin), origin: parsed.origin, username };
        return {
            items: [item],
            defaultId: LEGACY_ID,
            activeId: LEGACY_ID,
            passwords: password ? { [LEGACY_ID]: password } : {},
            legacy: true,
        };
    }

    // ---- views --------------------------------------------------------------------------------

    private toView(state: State, item: Stored): PikvmView {
        return {
            id: item.id,
            name: item.name,
            origin: item.origin,
            username: item.username,
            passwordSet: (state.passwords[item.id] ?? "") !== "",
            isDefault: item.id === state.defaultId,
            active: item.id === state.activeId,
        };
    }

    /** Every stored PiKVM, in the order they were added. */
    entries(): PikvmView[] {
        const state = this.read();
        return state.items.map((item) => this.toView(state, item));
    }

    /** The id of the active PiKVM; null while the list is empty. */
    activeId(): string | null {
        return this.read().activeId;
    }

    private resolved(state: State): ResolvedTarget {
        const item = state.items.find((i) => i.id === state.activeId);
        if (!item) return { origin: DEFAULT_ORIGIN, username: "", password: "" };
        return { origin: item.origin, username: item.username, password: state.passwords[item.id] ?? "" };
    }

    /** What to connect with: the active PiKVM, or the default address with no credentials while there is none. */
    resolve(): ResolvedTarget {
        return this.resolved(this.read());
    }

    /** The active PiKVM as a client may see it. */
    targetView(): TargetView {
        const { origin, username, password } = this.resolve();
        return { origin, username, passwordSet: password !== "" };
    }

    // ---- changing -----------------------------------------------------------------------------

    private find(state: State, id: string): Stored {
        const item = state.items.find((i) => i.id === id);
        if (!item) throw new TargetNotFound();
        return item;
    }

    private newId(state: State): string {
        for (;;) {
            const id = randomBytes(6).toString("hex");
            if (id !== LEGACY_ID && !state.items.some((i) => i.id === id)) return id;
        }
    }

    /** Add a PiKVM. The first one becomes the default and the active one. Nothing is written if anything is refused. */
    add(input: PikvmAddInput): PikvmView {
        const state = this.read();
        const name = cleanName(input.name);
        const parsed = parseOrigin(input.origin);
        const username = input.username !== undefined ? input.username.trim() : parsed.username;
        const password = input.password ?? parsed.password;
        const id = this.newId(state);
        const item: Stored = { id, name, origin: parsed.origin, username };
        const first = state.items.length === 0;
        const next: State = {
            items: [...state.items, item],
            defaultId: first ? id : state.defaultId,
            activeId: first ? id : state.activeId,
            passwords: password ? { ...state.passwords, [id]: password } : state.passwords,
            legacy: false,
        };
        this.commit(state, next);
        return this.toView(next, item);
    }

    /** Change one PiKVM. Fields not given keep their value; an empty password removes it. */
    update(id: string, patch: PikvmPatchInput): PikvmView {
        const state = this.read();
        const current = this.find(state, id);
        let { origin, username } = current;
        let password: string | undefined = patch.password;
        if (patch.origin !== undefined) {
            const parsed = parseOrigin(patch.origin);
            origin = parsed.origin;
            // Credentials typed into the address are what the old window took; they count as typed fields.
            if (parsed.username && patch.username === undefined) username = parsed.username;
            if (parsed.password && password === undefined) password = parsed.password;
        }
        if (patch.username !== undefined) username = patch.username.trim();
        const name = patch.name !== undefined ? cleanName(patch.name) : current.name;
        const stored = state.passwords[id] ?? "";
        const nextPassword = password ?? stored;
        const passwords = { ...state.passwords };
        if (nextPassword) passwords[id] = nextPassword;
        else delete passwords[id];
        const item: Stored = { id, name, origin, username };
        const next: State = {
            ...state,
            items: state.items.map((i) => (i.id === id ? item : i)),
            passwords,
            legacy: false,
        };
        this.commit(state, next);
        return this.toView(next, item);
    }

    /** Remove one PiKVM. Removing the default promotes the next one; removing the last leaves the list empty. */
    remove(id: string): PikvmView[] {
        const state = this.read();
        this.find(state, id);
        const index = state.items.findIndex((i) => i.id === id);
        const items = state.items.filter((i) => i.id !== id);
        // The next one after it, or the last one when it was the last.
        const successor = items[Math.min(index, items.length - 1)]?.id ?? null;
        const defaultId = state.defaultId === id ? successor : state.defaultId;
        const activeId = state.activeId === id ? (defaultId ?? successor) : state.activeId;
        const passwords = { ...state.passwords };
        delete passwords[id];
        const next: State = { items, defaultId, activeId, passwords, legacy: false };
        this.commit(state, next);
        return items.map((item) => this.toView(next, item));
    }

    /** Make one PiKVM the default. */
    setDefault(id: string): PikvmView[] {
        const state = this.read();
        this.find(state, id);
        const next: State = { ...state, defaultId: id, legacy: false };
        this.commit(state, next);
        return next.items.map((item) => this.toView(next, item));
    }

    /** Make one PiKVM the active one: the proxy, the agent and the screen watch follow it. */
    activate(id: string): PikvmView[] {
        const state = this.read();
        this.find(state, id);
        const next: State = { ...state, activeId: id, legacy: false };
        this.commit(state, next);
        return next.items.map((item) => this.toView(next, item));
    }

    /**
     * Change the active PiKVM. With none stored yet this adds the first one, named after its host: that is how
     * an install saved its address before the list existed.
     */
    save(change: TargetChange): ResolvedTarget {
        const state = this.read();
        if (state.activeId !== null) {
            this.update(state.activeId, change);
            return this.resolve();
        }
        const parsed = parseOrigin(change.origin ?? DEFAULT_ORIGIN);
        this.add({
            name: nameFromOrigin(parsed.origin),
            origin: change.origin ?? DEFAULT_ORIGIN,
            ...(change.username !== undefined ? { username: change.username } : {}),
            ...(change.password !== undefined ? { password: change.password } : {}),
        });
        return this.resolve();
    }

    // ---- writing ------------------------------------------------------------------------------

    /** Write the new state (credentials first, so a crash never leaves an entry without its password), then say so. */
    private commit(before: State, next: State): void {
        const wasLegacy = before.legacy;
        const previous = this.resolved(before);
        this.writeCredentials(next.passwords);
        this.writeAtomic(
            this.list,
            JSON.stringify(
                {
                    version: 1,
                    active: next.activeId,
                    items: next.items.map((i) => ({
                        id: i.id,
                        name: i.name,
                        origin: i.origin,
                        username: i.username,
                        isDefault: i.id === next.defaultId,
                    })),
                },
                null,
                2,
            ),
        );
        if (wasLegacy) this.retireLegacy();
        const current = this.resolved(next);
        if (current.origin !== previous.origin || current.username !== previous.username || current.password !== previous.password) {
            for (const listener of this.listeners) listener(current);
        }
    }

    private writeCredentials(passwords: Readonly<Record<string, string>>): void {
        if (Object.keys(passwords).length > 0) this.writeAtomic(this.credentials, JSON.stringify(passwords));
        else rmSync(this.credentials, { force: true });
    }

    /** The old files are now copied into the new ones: drop the old password file and the credentials in the address. */
    private retireLegacy(): void {
        rmSync(this.legacyCredentials, { force: true });
        const json = this.readJson(this.legacyConfig);
        const origin = json?.["origin"];
        if (!json || typeof origin !== "string") return;
        let url: URL;
        try {
            url = new URL(origin);
        } catch {
            return;
        }
        if (!url.username && !url.password) return;
        url.username = "";
        url.password = "";
        this.writeAtomic(this.legacyConfig, JSON.stringify({ ...json, origin: url.href }, null, 2));
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
