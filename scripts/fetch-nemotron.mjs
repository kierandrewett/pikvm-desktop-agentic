// Download the Nemotron speaker diarizer pinned in deploy/nemotron.lock (NeMo-Speech.cpp's CPU engine and the q8_0 GGUF model), check
// every sha256, and lay them out where the diarizer looks (PIKVM_NEMOTRON_DIR):
//
//   node scripts/fetch-nemotron.mjs --target linux-x64 [--out builds/nemotron/linux-x64]
//
//   <out>/bin/nemo-speech                       the engine (its RPATH is $ORIGIN/../lib)
//   <out>/lib/                                  the engine's shared libraries (no cmake files)
//   <out>/share/licenses/nemo-speech/           the engine's Apache-2.0 licence and notices
//   <out>/share/licenses/Nemotron-3-Diarization/OpenMDW-1.1.txt   the model's licence
//   <out>/Nemotron-3-Diarization.q8_0.gguf      the model
//
// The target defaults to this machine's (linux-x64 or linux-arm64). The engine tarball's sha256 and the model's sha256 must match the
// pins; anything that does not is deleted and the script exits 1, so a tampered or truncated file is never left where the host would
// run it. A layout whose stamp already matches the pins is left alone. `--print-path` prints the destination and fetches nothing.
// `deploy/Dockerfile` runs it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const lock = JSON.parse(readFileSync(join(root, "deploy", "nemotron.lock"), "utf8"));
const target = arg("target") ?? `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const pin = lock.engine.targets[target];
if (!pin) {
    console.error(`No engine pin for ${target} in deploy/nemotron.lock. Known: ${Object.keys(lock.engine.targets).join(", ")}`);
    process.exit(1);
}
const out = resolve(arg("out") ?? join(root, "builds", "nemotron", target));
const stampFile = join(out, ".nemotron.json");
const stamp = JSON.stringify({ engine: pin.sha256, model: lock.model.sha256 });
if (process.argv.includes("--print-path")) {
    console.log(out);
    process.exit(0);
}

if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
    console.log(`The Nemotron diarizer (${target}) is already in ${out}`);
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "pikvm-nemotron-"));
const download = async (url, name, expectedSha, expectedBytes) => {
    console.log(`Fetching ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const file = join(work, name);
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, bytes);
    if (bytes.length !== expectedBytes) throw new Error(`${name} is ${bytes.length} bytes, not the pinned ${expectedBytes}`);
    const got = sha256(file);
    if (got !== expectedSha) throw new Error(`${name}: the download's sha256 is ${got}, not the pinned ${expectedSha}`);
    return file;
};

try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });

    const engineUrl = `https://github.com/${lock.engine.repository}/releases/download/${lock.engine.tag}/${pin.asset}`;
    const tarball = await download(engineUrl, pin.asset, pin.sha256, pin.bytes);
    const unpacked = join(work, "engine");
    mkdirSync(unpacked);
    execFileSync("tar", ["xzf", tarball, "-C", unpacked, "--strip-components=1"]);

    mkdirSync(join(out, "bin"), { recursive: true });
    copyFileSync(join(unpacked, "bin", "nemo-speech"), join(out, "bin", "nemo-speech"));
    chmodSync(join(out, "bin", "nemo-speech"), 0o755);
    cpSync(join(unpacked, "lib"), join(out, "lib"), { recursive: true, verbatimSymlinks: true, filter: (from) => !/[\\/]cmake([\\/]|$)/.test(from) });
    cpSync(join(unpacked, "share", "licenses", "nemo-speech"), join(out, "share", "licenses", "nemo-speech"), { recursive: true });

    const modelFile = await download(lock.model.url, lock.model.file, lock.model.sha256, lock.model.bytes);
    copyFileSync(modelFile, join(out, lock.model.file));
    const licenceDir = join(out, "share", "licenses", "Nemotron-3-Diarization");
    mkdirSync(licenceDir, { recursive: true });
    copyFileSync(join(root, "deploy", "licenses", "OpenMDW-1.1.txt"), join(licenceDir, "OpenMDW-1.1.txt"));

    writeFileSync(stampFile, stamp);
    console.log(`The Nemotron diarizer (${target}) is in ${out}`);
} catch (error) {
    rmSync(out, { recursive: true, force: true });
    console.error(`Could not fetch the Nemotron diarizer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(work, { recursive: true, force: true });
}
