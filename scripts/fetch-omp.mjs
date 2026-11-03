// Download omp's standalone binary for one target, as pinned in deploy/omp.lock, and check its sha256.
//
//   node scripts/fetch-omp.mjs [--target linux-x64] [--out builds/omp/linux-x64]
//
// The target defaults to this machine's. The binary lands at <out>/omp (omp.exe on Windows). A file that is already
// there and matches the pin is left alone; one that does not match is replaced. A download that does not match the pin
// is deleted and the script exits 1, so a tampered or truncated binary is never left where the app would run it.
// `--print-path` prints the destination and fetches nothing.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = resolve(import.meta.dirname, "..");

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
}

function hostTarget() {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const os = { linux: "linux", darwin: "darwin", win32: "win32" }[process.platform];
    if (!os) throw new Error(`omp has no binary for ${process.platform}`);
    return `${os}-${arch}`;
}

async function sha256(file) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
}

const lock = JSON.parse(await readFile(join(root, "deploy", "omp.lock"), "utf8"));
const target = arg("target") ?? hostTarget();
const pin = lock.targets[target];
if (!pin) {
    console.error(`No pin for ${target} in deploy/omp.lock. Known: ${Object.keys(lock.targets).join(", ")}`);
    process.exit(1);
}
const exe = target.startsWith("win32") ? "omp.exe" : "omp";
const out = resolve(arg("out") ?? join(root, "builds", "omp", lock.version, target));
const dest = join(out, exe);

if (process.argv.includes("--print-path")) {
    console.log(dest);
    process.exit(0);
}

if ((await sha256(dest).catch(() => undefined)) === pin.sha256) {
    console.log(`omp ${lock.version} (${target}) is already at ${dest}`);
    process.exit(0);
}

const url = `https://github.com/${lock.repository}/releases/download/${lock.tag}/${pin.asset}`;
console.log(`Fetching ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
    console.error(`Download failed: HTTP ${res.status}`);
    process.exit(1);
}
await mkdir(dirname(dest), { recursive: true });
const partial = `${dest}.part`;
const hash = createHash("sha256");
const sink = createWriteStream(partial, { mode: 0o755 });
await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
        for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
        }
    },
    sink,
);
const got = hash.digest("hex");
if (got !== pin.sha256) {
    await rm(partial, { force: true });
    console.error(`Checksum mismatch for ${pin.asset}: expected ${pin.sha256}, got ${got}. Nothing was installed.`);
    process.exit(1);
}
await chmod(partial, 0o755);
await rename(partial, dest);
console.log(`omp ${lock.version} (${target}) installed at ${dest}`);
