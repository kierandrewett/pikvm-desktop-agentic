// Download the speech models pinned in deploy/asr.lock, check every hash, and lay them out where the transcriber looks (PIKVM_ASR_MODELS).
//
//   node scripts/fetch-asr.mjs [--out builds/asr/models]
//
// The download's sha256 and each extracted file's sha256 must match the pin. Anything that does not is deleted and the script exits
// 1, so a tampered or truncated model is never left where the host would load it. `--print-path` prints the destination and fetches
// nothing. `deploy/Dockerfile` runs it (the stage installs bzip2 for the .tar.bz2 archives).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const { models } = JSON.parse(readFileSync(join(root, "deploy", "asr.lock"), "utf8"));
const out = resolve(arg("out") ?? join(root, "builds", "asr", "models"));
if (process.argv.includes("--print-path")) {
    console.log(out);
    process.exit(0);
}

const targets = models.flatMap((model) => model.files.map((file) => ({ model, file })));
const matches = ({ file }) => {
    try {
        return sha256(join(out, file.to)) === file.sha256;
    } catch {
        return false;
    }
};
if (targets.every(matches)) {
    console.log(`The speech models are already in ${out}`);
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "pikvm-asr-"));
try {
    for (const model of models) {
        if (model.files.every((file) => matches({ file }))) continue;
        console.log(`Fetching ${model.url}`);
        const res = await fetch(model.url, { redirect: "follow" });
        if (!res.ok) throw new Error(`${model.url} answered ${res.status}`);
        const download = join(work, model.url.split("/").pop());
        writeFileSync(download, Buffer.from(await res.arrayBuffer()));
        const got = sha256(download);
        if (got !== model.sha256) throw new Error(`${model.name}: the download's sha256 is ${got}, not the pinned ${model.sha256}`);
        let source = (file) => download;
        if (model.archive === "tar.bz2") {
            const unpacked = join(work, `unpacked-${models.indexOf(model)}`);
            mkdirSync(unpacked);
            execFileSync("tar", ["xjf", download, "-C", unpacked]);
            source = (file) => join(unpacked, file.from);
        }
        for (const file of model.files) {
            const from = source(file);
            if (sha256(from) !== file.sha256) throw new Error(`${file.to} does not match its pinned sha256`);
            mkdirSync(dirname(join(out, file.to)), { recursive: true });
            copyFileSync(from, join(out, file.to));
        }
    }
    console.log(`The speech models are in ${out}`);
} catch (error) {
    for (const { file } of targets) rmSync(join(out, file.to), { force: true });
    console.error(`Could not fetch the speech models: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(work, { recursive: true, force: true });
}
