/**
 * Signing in to a model subscription (Claude, ChatGPT/Codex) for one user, through the runtime's own `omp login <provider>`.
 *
 * The runtime keeps the credential, refreshes it and rotates accounts itself, in the user's own home (`<user>/home/.omp/agent`), so
 * nothing here ever sees or stores a token. This module only runs the login with that home, hands the sign-in address to the person
 * and passes back what they paste. The browser step ends on `http://localhost:<port>/callback`, which a remote browser cannot reach;
 * the runtime then asks for the final address or code on stdin, and that is the "paste" step in Settings.
 *
 * One login per user and provider at a time; it is killed after ten minutes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { paths } from "../paths.ts";
import { buildSpawn } from "./launch.ts";

export const LOGIN_PROVIDERS = ["anthropic", "openai-codex"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export type LoginState = "starting" | "waiting" | "done" | "failed";

export interface LoginView {
    id: string;
    provider: LoginProvider;
    state: LoginState;
    /** The address to open in a browser. Set once the runtime has printed it. */
    url?: string;
    /** Why it failed: the runtime's own last line, never a credential. */
    error?: string;
}

interface Login extends LoginView {
    userId: string;
    child: ChildProcess;
    timer: NodeJS.Timeout;
}

const LIFETIME_MS = 10 * 60_000;
const URL_WAIT_MS = 15_000;
const logins = new Map<string, Login>();

const view = (l: Login): LoginView => ({ id: l.id, provider: l.provider, state: l.state, ...(l.url ? { url: l.url } : {}), ...(l.error ? { error: l.error } : {}) });

function stop(l: Login): void {
    clearTimeout(l.timer);
    l.child.kill("SIGTERM");
}

/** Start a login. Resolves with the address to open, or rejects when the runtime printed none in time. `onDone` runs when it ends well. */
export async function startLogin(userId: string, provider: LoginProvider, onDone: () => void): Promise<LoginView> {
    for (const other of logins.values()) {
        if (other.userId === userId && other.provider === provider) {
            stop(other);
            logins.delete(other.id);
        }
    }
    const home = paths.user(userId).home;
    mkdirSync(home, { recursive: true });
    const { argv, env } = buildSpawn(userId, home, ["login", provider]);
    // `login` is a command of its own: the generated `--config` overlay that buildSpawn puts first is for sessions.
    // The host may have a desktop; the person opens the address in their own browser, which may be on another machine.
    const child = spawn(argv[0]!, ["login", provider], { env: { ...env, BROWSER: "true" }, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    const login = { id: randomUUID(), userId, provider, state: "starting", child } as Login;
    login.timer = setTimeout(() => {
        if (login.state === "starting" || login.state === "waiting") {
            login.state = "failed";
            login.error = "The sign-in took too long.";
            stop(login);
        }
    }, LIFETIME_MS);
    login.timer.unref();
    logins.set(login.id, login);

    let last = "";
    let seen!: () => void;
    const urlSeen = { promise: new Promise<void>((done) => (seen = done)), resolve: () => seen() };
    const read = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
            const text = line.trim();
            if (!text) continue;
            if (!login.url && /^https:\/\//.test(text)) {
                login.url = text;
                login.state = "waiting";
                urlSeen.resolve();
            } else if (!/^(Open this URL|Local shortcut|Complete login|A browser window|Waiting for)/.test(text)) {
                last = text;
            }
        }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (err) => {
        login.state = "failed";
        login.error = err.message;
        urlSeen.resolve();
    });
    child.on("exit", (code) => {
        clearTimeout(login.timer);
        if (login.state === "failed") return urlSeen.resolve();
        if (code === 0) {
            login.state = "done";
            onDone();
        } else {
            login.state = "failed";
            login.error = last.slice(0, 200) || "The sign-in did not finish.";
        }
        urlSeen.resolve();
    });
    const timeout = setTimeout(() => urlSeen.resolve(), URL_WAIT_MS);
    await urlSeen.promise;
    clearTimeout(timeout);
    if (!login.url) {
        stop(login);
        logins.delete(login.id);
        throw new Error(login.error ?? "The runtime printed no sign-in address.");
    }
    return view(login);
}

function owned(userId: string, id: string): Login | undefined {
    const l = logins.get(id);
    return l?.userId === userId ? l : undefined;
}

export function loginStatus(userId: string, id: string): LoginView | undefined {
    const l = owned(userId, id);
    return l && view(l);
}

/** Give the runtime what the person pasted: the final address of the browser tab, or the code. */
export function submitLogin(userId: string, id: string, input: string): boolean {
    const l = owned(userId, id);
    if (!l || l.state !== "waiting" || !l.child.stdin?.writable) return false;
    l.child.stdin.write(`${input.replace(/[\r\n]+/g, "").trim()}\n`);
    return true;
}

export function cancelLogin(userId: string, id: string): boolean {
    const l = owned(userId, id);
    if (!l) return false;
    stop(l);
    logins.delete(id);
    return true;
}
