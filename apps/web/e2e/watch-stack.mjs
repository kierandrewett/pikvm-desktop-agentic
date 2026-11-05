// The stack the screen-watch runs drive: the real web host (node dist/web-server.js) with the chat server in it, in front of
// tools/fake-kvmd, with tools/fake-push as the push service and, unless the run is the real smoke, tools/fake-openrouter as
// OpenRouter. Nothing here touches a real PiKVM. Scratch lives under ~/.cache (the machine's /tmp cleaner deletes files mid-run).
//
// sharp is not a dependency of the repo (the image installs it): SHARP_MODULES names a node_modules that has it. It draws the
// two frames the fake kvmd serves, and the host needs it too (NODE_PATH).
//
// With E2E_WEB set the host is the IMAGE, started by deploy/e2e/up-inspectable.sh (E2E_ENV_FILE carries the watch's pacing and
// PIKVM_PUSH_ALLOW_LOCAL): nothing is started here. E2E_WEB, E2E_KVMD, E2E_PUSH, E2E_OR are the published origins of the fakes,
// E2E_PUSH_AUDIENCE is the push service as the host names it, E2E_OR_URL the OpenRouter base URL as the host sees it, E2E_DATA the
// host directory mounted at /data and E2E_CONTAINER the container (restarted and logged through podman).

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const home = process.env.HOME;
export const scratch = join(home, ".cache", "pikvm-e2e", "watch");
mkdirSync(scratch, { recursive: true });

export const CANARY = { key: `sk-or-e2e-${Math.random().toString(16).slice(2, 18)}`, kvmPassword: `kvm-e2e-pass-${Math.random().toString(16).slice(2, 12)}` };

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function start(name, args, env) {
    const lines = [];
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (data) => lines.push(...String(data).split("\n").filter(Boolean));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    return {
        name,
        child,
        lines,
        stop: () =>
            new Promise((done) => {
                if (child.exitCode !== null) return done();
                child.once("exit", done);
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 4000).unref();
            }),
    };
}

export async function until(probe, what, ms = 20000, every = 150) {
    const end = Date.now() + ms;
    for (;;) {
        try {
            const value = await probe();
            if (value) return value;
        } catch {
            /* not yet */
        }
        if (Date.now() > end) throw new Error(`${what} did not happen within ${ms} ms`);
        await sleep(every);
    }
}

const strip = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

/** The two frames, drawn with sharp: a terminal installing a package, and the same terminal with a failure dialog over it. */
export async function drawFrames() {
    const modules = process.env.SHARP_MODULES ?? join(home, ".cache/pikvm-e2e/sharp/node_modules");
    const sharp = createRequire(`${modules}/`)("sharp");
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const lines = (list) =>
        list
            .map((l, i) => `<text x="24" y="${52 + i * 26}" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="${l.c ?? "#d0d0d0"}">${esc(l.t)}</text>`)
            .join("");
    const head = `<rect width="1280" height="720" fill="#1a1b26"/><rect width="1280" height="34" fill="#16161e"/><text x="16" y="23" font-family="DejaVu Sans, sans-serif" font-size="15" fill="#a9b1d6">Terminal - user@build-box: ~</text>`;
    const base = [
        { t: "user@build-box:~$ sudo apt install -y postgresql-16", c: "#9ece6a" },
        { t: "Reading package lists... Done" },
        { t: "Building dependency tree... Done" },
        { t: "The following NEW packages will be installed: postgresql-16 postgresql-client-16" },
        { t: "Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 postgresql-16 amd64 16.4-1 [18.9 MB]" },
        { t: "Fetched 21.2 MB in 6s (3,540 kB/s)" },
        { t: "Preparing to unpack .../postgresql-16_16.4-1_amd64.deb ..." },
        { t: "Setting up postgresql-client-16 (16.4-1) ..." },
    ];
    const dialog = (title, bar, line1, line2) =>
        `<rect x="360" y="230" width="560" height="230" rx="10" fill="#f2f2f2" stroke="#888" stroke-width="2"/><rect x="360" y="230" width="560" height="42" rx="10" fill="${bar}"/><text x="380" y="258" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#fff" font-weight="bold">${title}</text><text x="384" y="318" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#222">${line1}</text><text x="384" y="352" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#222">${line2}</text><rect x="760" y="396" width="120" height="42" rx="6" fill="#ddd" stroke="#888"/><text x="797" y="423" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#222">Close</text>`;
    const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${head}${body}</svg>`);
    const jpeg = (body) => sharp(svg(body)).jpeg({ quality: 85 }).toBuffer();
    const installing = [...base, { t: "Progress: [ 68%] [##########################.............]", c: "#e0af68" }];
    return {
        /** The terminal, installing. */
        installing: await jpeg(lines(installing)),
        /** The same with a caret blinking at the end of the last line: a change far under the threshold. */
        caret: await jpeg(lines(installing) + `<rect x="650" y="${52 + 8 * 26 - 16}" width="10" height="20" fill="#d0d0d0"/>`),
        /** The failure dialog over the terminal. */
        failed: await jpeg(
            lines([...base, { t: "dpkg: error processing package postgresql-16 (--configure):", c: "#f7768e" }, { t: "E: Sub-process /usr/bin/dpkg returned an error code (1)", c: "#f7768e" }]) +
                dialog("Installation failed", "#d33", "Error: could not configure postgresql-16.", "dpkg returned exit status 1 (disk full)."),
        ),
        /** A second, different dialog: the install finished. */
        done: await jpeg(
            lines([...base, { t: "Setting up postgresql-16 (16.4-1) ...", c: "#9ece6a" }, { t: "Processing triggers for man-db ... done", c: "#9ece6a" }]) +
                dialog("Installation complete", "#2a7", "PostgreSQL 16 was installed successfully.", "The service is running on port 5432."),
        ),
    };
}

/**
 * The host's own grey reader and diff, bundled from source: what the watch measures, measured on the run's frames. The bundle is
 * written beside sharp (so `require("sharp")` finds it) and removed again.
 */
export async function loadMeasure() {
    const { build } = await import("esbuild");
    const modules = process.env.SHARP_MODULES ?? join(home, ".cache/pikvm-e2e/sharp/node_modules");
    const entry = join(scratch, "measure-entry.ts");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
        entry,
        `export { createSharpImageOps } from ${JSON.stringify(join(root, "src/image-ops-sharp.ts"))};\nexport { changedFraction, zoneCells, zoneChangedFraction } from ${JSON.stringify(join(root, "src/server/watch/frame-diff.ts"))};\nexport * as limits from ${JSON.stringify(join(root, "src/server/watch/limits.ts"))};\n`,
    );
    const out = join(modules, "..", ".watch-measure.cjs");
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "cjs", external: ["sharp"], logLevel: "error" });
    const loaded = createRequire(out)(out);
    rmSync(out, { force: true });
    rmSync(entry, { force: true });
    return loaded;
}

/** The image's own watch stack: see the header. */
async function externalWatchStack({ openrouter }) {
    const need = (name) => process.env[name] ?? (() => { throw new Error(`${name} is required with E2E_WEB`); })();
    const sh = (args) => spawnSync("podman", args, { encoding: "utf8" });
    const container = need("E2E_CONTAINER");
    const web = need("E2E_WEB");
    const common = await watchStackCommon({
        web,
        fakeUrl: need("E2E_KVMD"),
        pushUrl: need("E2E_PUSH"),
        orControl: need("E2E_OR"),
        orUrl: openrouter === "fake" ? need("E2E_OR_URL") : "https://openrouter.ai/api/v1",
        data: need("E2E_DATA"),
        logs: () => { const r = sh(["logs", container]); return `${r.stdout}${r.stderr}`; },
        async restartHost() {
            sh(["restart", "-t", "5", container]);
            await until(async () => (await fetch(`${web}/app/manifest.webmanifest`)).ok, "web host");
            await until(async () => (await (await fetch(`${web}/app/api/v1/state`)).json()).features.chat, "the chat server");
        },
        async stop() {},
    });
    return { ...common, pushAudience: need("E2E_PUSH_AUDIENCE"), host: () => ({ lines: [] }) };
}

/**
 * Bring the stack up. `openrouter: "fake"` starts tools/fake-openrouter; "real" starts none (the run adds the real provider).
 * Ports default to a range of their own so a run does not collide with the other suites' servers.
 */
export async function startWatchStack({ openrouter = "fake", ports = {}, env = {}, dataDir } = {}) {
    if (process.env.E2E_WEB) return externalWatchStack({ openrouter });
    const p = { web: 18290, kvmd: 14710, push: 14720, openrouter: 14730, ...ports };
    const data = dataDir ?? mkdtempSync(join(scratch, "data-"));
    const sharp = process.env.SHARP_MODULES ?? join(home, ".cache/pikvm-e2e/sharp/node_modules");
    const omp = process.env.OMP_BIN ?? join(root, "builds/omp/18.14.2/linux-x64/omp");

    const fake = start("fake-kvmd", [...strip, "tools/fake-kvmd/server.ts", "--port", String(p.kvmd)], {});
    const push = start("fake-push", [...strip, "tools/fake-push/server.ts", "--port", String(p.push)], {});
    const procs = [fake, push];
    await until(async () => (await fetch(`http://127.0.0.1:${p.kvmd}/__fake/hid`)).ok, "fake-kvmd");
    await until(async () => (await fetch(`http://127.0.0.1:${p.push}/__fake/received`)).ok, "fake-push");
    let orUrl = "https://openrouter.ai/api/v1";
    if (openrouter === "fake") {
        const or = start("fake-openrouter", [...strip, "tools/fake-openrouter/server.ts", "--port", String(p.openrouter)], {});
        procs.push(or);
        await until(async () => (await fetch(`http://127.0.0.1:${p.openrouter}/__fake/requests`)).ok, "fake-openrouter");
        orUrl = `http://127.0.0.1:${p.openrouter}/api/v1`;
    }

    const hostEnv = {
        PIKVM_URL: `http://127.0.0.1:${p.kvmd}`,
        PIKVM_PASSWORD: CANARY.kvmPassword,
        PORT: String(p.web),
        PIKVM_DATA_DIR: data,
        NODE_PATH: sharp,
        HOME: join(data, "home"),
        // The watch's pace for a run that cannot wait a minute between checks. The host floors the interval at 2 s whatever is set.
        PIKVM_WATCH_INTERVAL_MS: "2000",
        PIKVM_WATCH_SETTLE_MS: "3000",
        PIKVM_WATCH_MIN_GAP_SEC: "20",
        PIKVM_WATCH_DAILY_CAP: "4",
        // A subscription on a push service of ours, not a browser vendor's.
        PIKVM_PUSH_ALLOW_LOCAL: "1",
        ...(existsSync(omp) ? { OMP_BIN: omp } : {}),
        ...env,
    };
    mkdirSync(join(data, "home"), { recursive: true });
    let host;
    const startHost = async () => {
        host = start("web host", ["dist/web-server.js"], hostEnv);
        procs.push(host);
        await until(async () => (await fetch(`http://127.0.0.1:${p.web}/app/manifest.webmanifest`)).ok, "web host");
        await until(async () => (await (await fetch(`http://127.0.0.1:${p.web}/app/api/v1/state`)).json()).features.chat, "the chat server");
    };
    await startHost();

    return watchStackCommon({
        web: `http://127.0.0.1:${p.web}`,
        fakeUrl: `http://127.0.0.1:${p.kvmd}`,
        pushUrl: `http://127.0.0.1:${p.push}`,
        orControl: `http://127.0.0.1:${p.openrouter}`,
        orUrl,
        data,
        host: () => host,
        logs: () => host.lines.join("\n"),
        async restartHost() {
            await host.stop();
            await startHost();
        },
        async stop() {
            for (const proc of procs) await proc.stop();
        },
    });
}

/** What both stacks answer with: the helpers over the host's origins. `host`, `logs`, `restartHost` and `stop` are the stack's own. */
function watchStackCommon({ web, fakeUrl, pushUrl, orControl, orUrl, data, host, logs, restartHost, stop }) {
    const json = async (url, init) => (await fetch(url, init)).json();
    const post = (url, body, headers = {}) =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

    return {
        web,
        fake: fakeUrl,
        push: pushUrl,
        orUrl,
        orControl,
        data,
        host,
        logs,
        /** Store the OpenRouter provider the way Settings, Providers does (the chat server's own route and request header). */
        async setProvider(apiKey = CANARY.key, baseUrl = orUrl) {
            const res = await fetch(`${web}/app/chat/api/settings/agent.providers`, {
                method: "PUT",
                headers: { "content-type": "application/json", "x-chat-request": "1" },
                body: JSON.stringify({ value: { openrouter: { enabled: true, baseUrl, api: "openai-completions", apiKey, models: [] } } }),
            });
            if (!res.ok) throw new Error(`storing the provider: ${res.status} ${await res.text()}`);
        },
        async removeProvider() {
            const res = await fetch(`${web}/app/chat/api/settings/agent.providers`, { method: "DELETE", headers: { "x-chat-request": "1" } });
            if (!res.ok) throw new Error(`removing the provider: ${res.status}`);
        },
        watch: () => json(`${web}/app/api/v1/watch`),
        patchWatch: (body) => fetch(`${web}/app/api/v1/watch`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        checks: async (limit = 50) => (await json(`${web}/app/api/v1/watch/checks?limit=${limit}`)).checks,
        /** Serve this JPEG as the target's screen. */
        async show(jpeg) {
            const res = await fetch(`${fakeUrl}/__fake/picture?name=custom`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg });
            if (!res.ok) throw new Error(`fake-kvmd refused the picture: ${res.status}`);
        },
        fakeGet: (path) => json(`${fakeUrl}${path}`),
        fakePost: (path) => fetch(`${fakeUrl}${path}`, { method: "POST" }),
        /** How many snapshots the host has asked the fake kvmd for so far. */
        async snapshots() {
            const { requests } = await json(`${fakeUrl}/__fake/requests`);
            return (requests ?? []).filter((r) => r.path === "/api/streamer/snapshot").length;
        },
        pushReceived: async () => (await json(`${pushUrl}/__fake/received`)).received,
        pushSubscribe: () => post(`${pushUrl}/__fake/subscription`).then((r) => r.json()),
        pushStatus: (id, status) => post(`${pushUrl}/__fake/status?id=${id}${status ? `&status=${status}` : ""}`),
        orScript: (body) => post(`${orControl}/__fake/script`, body),
        orCalls: async () => (await json(`${orControl}/__fake/requests`)).calls,
        restartHost,
        stop,
    };
}
