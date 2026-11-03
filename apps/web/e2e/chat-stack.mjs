// The stack the chat integration run drives: tools/fake-kvmd (what the PiKVM would receive),
// tools/fake-model (an OpenAI-compatible provider), and the real web host (node dist/web-server.js)
// with the real chat server inside it and the real omp binary behind that. Nothing is mocked between
// the browser and the agent. It never touches a real PiKVM.
//
// Scratch lives under ~/.cache (the machine's /tmp cleaner deletes files mid-run). sharp is not a
// dependency of the repo (the web image installs it); SHARP_MODULES names a node_modules that has it.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const home = process.env.HOME;
export const scratch = join(home, ".cache", "pikvm-e2e", "run");
mkdirSync(scratch, { recursive: true });

/** Secrets that must never reach a browser or the agent: found anywhere they should not be, they fail the run. */
export const CANARY = {
    providerKey: `sk-e2e-${randomBytes(9).toString("hex")}`,
    kvmPassword: `kvm-e2e-pass-${randomBytes(9).toString("hex")}`,
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function start(name, command, args, env) {
    const lines = [];
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (data) => lines.push(...String(data).split("\n").filter(Boolean));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    return { name, child, lines, stop: () => new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 4000).unref(); }) };
}

async function until(probe, what, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
        try {
            if (await probe()) return;
        } catch {
            /* not yet */
        }
        if (Date.now() > end) throw new Error(`${what} did not come up`);
        await wait(150);
    }
}

export async function startStack({ web = 18099, kvmd = 14510, model = 14517, dataDir } = {}) {
    const data = dataDir ?? mkdtempSync(join(scratch, "data-"));
    const strip = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
    const omp = process.env.OMP_BIN ?? join(root, "builds/omp/18.14.2/linux-x64/omp");
    const sharp = process.env.SHARP_MODULES ?? join(home, ".cache/pikvm-e2e/sharp/node_modules");

    const fake = start("fake-kvmd", process.execPath, [...strip, "tools/fake-kvmd/server.ts", "--port", String(kvmd)], {});
    const llm = start("fake-model", process.execPath, [...strip, "tools/fake-model/server.ts"], { PORT: String(model) });
    await until(async () => (await fetch(`http://127.0.0.1:${kvmd}/__fake/hid`)).ok, "fake-kvmd");
    await until(async () => (await fetch(`http://127.0.0.1:${model}/v1/models`)).ok, "fake-model");

    const host = start("web host", process.execPath, ["dist/web-server.js"], {
        PIKVM_URL: `http://127.0.0.1:${kvmd}`,
        PIKVM_PASSWORD: CANARY.kvmPassword,
        PORT: String(web),
        PIKVM_DATA_DIR: data,
        OMP_BIN: omp,
        NODE_PATH: sharp,
        HOME: join(data, "home"),
    });
    mkdirSync(join(data, "home"), { recursive: true });
    await until(async () => (await fetch(`http://127.0.0.1:${web}/app/manifest.webmanifest`)).ok, "web host");
    await until(async () => (await (await fetch(`http://127.0.0.1:${web}/app/api/v1/state`)).json()).features.chat, "the chat server");

    return {
        web: `http://127.0.0.1:${web}`,
        fake: `http://127.0.0.1:${kvmd}`,
        model: `http://127.0.0.1:${model}/v1`,
        data,
        omp,
        host,
        procs: [host, llm, fake],
        logs: () => host.lines.join("\n"),
        /** The pids of the agent processes (omp) the host started. */
        agentPids() {
            const out = [];
            for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
                try {
                    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
                    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
                    if (ppid === host.child.pid) out.push(Number(pid));
                } catch {
                    /* gone */
                }
            }
            return out;
        },
        async stop() {
            for (const proc of [host, llm, fake]) await proc.stop();
        },
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const stack = await startStack();
    console.log(JSON.stringify({ web: stack.web, fake: stack.fake, model: stack.model, data: stack.data }));
    process.on("SIGINT", async () => {
        await stack.stop();
        process.exit(0);
    });
    await new Promise(() => {});
}
