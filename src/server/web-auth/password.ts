/**
 * The password method: PIKVM_LOGIN_USER with PIKVM_LOGIN_PASSWORD_HASH (scrypt) or PIKVM_LOGIN_PASSWORD (plain).
 *
 * A hash line reads `scrypt$N$r$p$saltB64$hashB64` (standard base64). `node dist/web-server.js --hash-password` writes one.
 * The user name and the password are each compared in constant time, and the password is always checked, against a
 * dummy hash of the same cost when the user name is not the configured one, so how long a refusal takes does not say
 * which of the two was wrong.
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const MIN_COST = 16384;
const MAX_MEMORY = 256 * 1024 * 1024;
const DEFAULT_COST = { N: 65536, r: 8, p: 2 } as const;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface ScryptHash {
    N: number;
    r: number;
    p: number;
    salt: Buffer;
    hash: Buffer;
}

export type Scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

const nodeScrypt: Scrypt = (password, salt, keylen, options) => {
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    scryptCallback(password.normalize("NFKC"), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
    return promise;
};

/** How much memory scrypt needs with these parameters; node refuses above `maxmem`. */
function memory(N: number, r: number): number {
    return 128 * N * r;
}

/** Parse a hash line, or say what is wrong with it (never echoing it). */
export function parseHash(line: string): ScryptHash {
    const parts = line.trim().split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
        throw new Error("PIKVM_LOGIN_PASSWORD_HASH must look like scrypt$N$r$p$salt$hash (make one with --hash-password)");
    }
    const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (!Number.isInteger(N) || N < MIN_COST || (N & (N - 1)) !== 0) {
        throw new Error(`PIKVM_LOGIN_PASSWORD_HASH: N must be a power of two of at least ${MIN_COST}`);
    }
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16 || memory(N, r) > MAX_MEMORY) {
        throw new Error("PIKVM_LOGIN_PASSWORD_HASH: r or p out of range, or the hash needs too much memory");
    }
    const salt = Buffer.from(parts[4]!, "base64");
    const hash = Buffer.from(parts[5]!, "base64");
    if (salt.length < 8 || hash.length < 16 || hash.length > 128) {
        throw new Error("PIKVM_LOGIN_PASSWORD_HASH: the salt or the hash has a wrong length");
    }
    return { N, r, p, salt, hash };
}

async function derive(password: string, h: Pick<ScryptHash, "N" | "r" | "p" | "salt">, length: number, run: Scrypt): Promise<Buffer> {
    return run(password, h.salt, length, { N: h.N, r: h.r, p: h.p, maxmem: memory(h.N, h.r) + 1024 * 1024 });
}

/** A hash line for `password`, with a fresh salt. */
export async function hashPassword(password: string, cost: { N: number; r: number; p: number } = DEFAULT_COST): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, { ...cost, salt }, HASH_BYTES, nodeScrypt);
    return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Equal strings, in time that does not depend on where they differ. Hashing first gives both sides equal length. */
export function sameText(a: string, b: string): boolean {
    return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Runs at most two scrypt derivations at once: each holds tens of megabytes. */
class Queue {
    private running = 0;
    private readonly waiting: Array<() => void> = [];
    constructor(private readonly limit: number) {}

    async run<T>(job: () => Promise<T>): Promise<T> {
        if (this.running >= this.limit) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.waiting.push(resolve);
            await promise;
        }
        this.running += 1;
        try {
            return await job();
        } finally {
            this.running -= 1;
            this.waiting.shift()?.();
        }
    }
}

export interface PasswordLogin {
    /** Does this user name and password match? Always does the same work, whichever of the two is wrong. */
    check(user: string, password: string): Promise<boolean>;
    /** What a session made by this method is bound to, so changing the user or the password ends it. */
    material: string;
}

export interface PasswordConfig {
    user: string;
    /** A hash line, or the password itself when `plain` is set. */
    secret: string;
    plain: boolean;
}

/** `run` is a test seam: the derivation, counted. */
export function createPasswordLogin(config: PasswordConfig, run: Scrypt = nodeScrypt): PasswordLogin {
    const queue = new Queue(2);
    if (config.plain) {
        return {
            material: `plain\0${config.user}\0${config.secret}`,
            async check(user, password) {
                const userOk = sameText(user, config.user);
                const passwordOk = sameText(password, userOk ? config.secret : randomBytes(16).toString("hex"));
                return userOk && passwordOk;
            },
        };
    }
    const real = parseHash(config.secret);
    const dummy = { N: real.N, r: real.r, p: real.p, salt: randomBytes(real.salt.length), hash: randomBytes(real.hash.length) };
    return {
        material: `scrypt\0${config.user}\0${config.secret}`,
        async check(user, password) {
            const userOk = sameText(user, config.user);
            const against = userOk ? real : dummy;
            const key = await queue.run(() => derive(password, against, against.hash.length, run));
            return timingSafeEqual(key, against.hash) && userOk;
        },
    };
}

/** `Authorization: Basic` as `[user, password]`, or undefined when it is not one. */
export function parseBasic(header: string): [string, string] | undefined {
    if (!header.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? undefined : [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

/** The password, read from stdin without echoing it: a line on a terminal, or all of a pipe. */
async function readPassword(): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
    }
    process.stderr.write("Password: ");
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let typed = "";
    const finish = (): void => {
        stdin.setRawMode(false);
        stdin.off("data", onData);
        stdin.pause();
        process.stderr.write("\n");
    };
    const onData = (chunk: Buffer): void => {
        for (const ch of chunk.toString("utf-8")) {
            if (ch === "\r" || ch === "\n" || ch === "\u0004") {
                finish();
                return resolve(typed);
            }
            if (ch === "\u0003") {
                finish();
                return reject(new Error("cancelled"));
            }
            if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
            else typed += ch;
        }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    return promise;
}

/** `node dist/web-server.js --hash-password`: prints the hash line and nothing else on stdout. Returns the exit code. */
export async function hashPasswordCommand(): Promise<number> {
    try {
        const password = await readPassword();
        if (password.length === 0) {
            console.error("[web] the password is empty");
            return 1;
        }
        console.log(await hashPassword(password));
        return 0;
    } catch (err) {
        console.error(`[web] could not hash: ${err instanceof Error ? err.message : "failed"}`);
        return 1;
    }
}
