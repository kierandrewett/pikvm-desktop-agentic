// Download the OCR models pinned in deploy/ocr.lock, check every hash, and put the three files the fast alerts need in a directory.
//
//   node scripts/fetch-ocr.mjs [--out builds/ocr/models]
//
// The tarball's sha256 and each file's sha256 must match the pin. Anything that does not is deleted and the script exits 1, so a
// tampered or truncated model is never left where the host would load it. `--print-path` prints the destination and fetches
// nothing. `deploy/Dockerfile` runs it; a dev checkout only needs it to run the real-engine test (see tests/watch-ocr.test.ts).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const { models } = JSON.parse(readFileSync(join(root, "deploy", "ocr.lock"), "utf8"));
const out = resolve(arg("out") ?? join(root, "builds", "ocr", "models"));
if (process.argv.includes("--print-path")) {
    console.log(out);
    process.exit(0);
}

const alreadyThere = Object.entries(models.files).every(([name, hash]) => {
    try {
        return sha256(join(out, name)) === hash;
    } catch {
        return false;
    }
});
if (alreadyThere) {
    console.log(`The OCR models (${models.package} ${models.version}) are already in ${out}`);
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "pikvm-ocr-"));
try {
    console.log(`Fetching ${models.tarball}`);
    const res = await fetch(models.tarball, { redirect: "follow" });
    if (!res.ok) throw new Error(`the download answered ${res.status}`);
    const tarball = join(work, "models.tgz");
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    const got = sha256(tarball);
    if (got !== models.tarballSha256) throw new Error(`the tarball's sha256 is ${got}, not the pinned ${models.tarballSha256}`);
    execFileSync("tar", ["xzf", tarball, "-C", work, ...Object.keys(models.files).map((name) => `package/assets/${name}`)]);
    mkdirSync(out, { recursive: true });
    for (const [name, hash] of Object.entries(models.files)) {
        const file = join(work, "package", "assets", name);
        if (sha256(file) !== hash) throw new Error(`${name} does not match its pinned sha256`);
        copyFileSync(file, join(out, name));
    }
    console.log(`The OCR models are in ${out}`);
} catch (error) {
    for (const name of Object.keys(models.files)) rmSync(join(out, name), { force: true });
    console.error(`Could not fetch the OCR models: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(work, { recursive: true, force: true });
}
