import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * tools/fake-kvmd for a test, with a typed handle on its control API.
 *
 * The fake has a top-level await, which the CJS test bundle cannot hold, so it is bundled to ESM
 * on its own and imported, from inside node_modules so that its `ws` import resolves.
 */

export interface FakeHidEvent {
    seq: number;
    client: number;
    event_type: string;
    event: Record<string, unknown>;
}

export interface FakeRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    authUser: string | null;
    body: string | null;
}

export interface FakeState {
    clients: number;
    wsAuthUsers: (string | null)[];
    keysDown: string[];
    buttonsDown: string[];
    mouse: { absolute: boolean; output: string };
    atx: { leds: { power: boolean } };
}

export interface FakeKvmdHandle {
    url: string;
    close(): Promise<void>;
    post(path: string, body?: string): Promise<void>;
    hid(type?: string): Promise<FakeHidEvent[]>;
    requests(): Promise<FakeRequest[]>;
    state(): Promise<FakeState>;
    reset(): Promise<void>;
}

export async function startFakeKvmd(): Promise<FakeKvmdHandle> {
    const out = mkdtempSync(join(process.cwd(), "node_modules", ".fake-kvmd-"));
    execFileSync(resolve(process.cwd(), "node_modules/.bin/esbuild"), [
        resolve(process.cwd(), "tools/fake-kvmd/server.ts"),
        `--outfile=${join(out, "fake-kvmd.mjs")}`,
        "--platform=node",
        "--format=esm",
        "--bundle",
        "--packages=external",
        "--log-level=error",
    ]);
    const { startFakeKvmd: start } = (await import(pathToFileURL(join(out, "fake-kvmd.mjs")).href)) as {
        startFakeKvmd: (o: { port: number }) => Promise<{ url: string; close(): Promise<void> }>;
    };
    const fake = await start({ port: 0 });
    const get = async <T>(path: string): Promise<T> => (await (await fetch(fake.url + path)).json()) as T;
    const post = async (path: string, body?: string): Promise<void> => {
        const res = await fetch(fake.url + path, { method: "POST", ...(body ? { body } : {}) });
        if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    };
    return {
        url: fake.url,
        post,
        hid: async (type) => (await get<{ events: FakeHidEvent[] }>(`/__fake/hid${type ? `?type=${type}` : ""}`)).events,
        requests: async () => (await get<{ requests: FakeRequest[] }>("/__fake/requests")).requests,
        state: () => get<FakeState>("/__fake/state"),
        reset: () => post("/__fake/reset"),
        async close() {
            await fake.close();
            rmSync(out, { recursive: true, force: true });
        },
    };
}

/** Poll until `check` is true; the fake handles a socket frame a moment after the client sent it. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}
