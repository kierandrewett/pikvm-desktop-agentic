import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* The packaged app once shipped no agent for the whole life of the project, and nothing noticed because
 * nothing asserted that a package had to contain one. The agent is omp's standalone binary now; these
 * tests are the assertion that every package and the image carry it, checked, and no Python. */

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const makefile = read("Makefile");
const pack = read("scripts/package.mjs");
const dockerfile = read("deploy/Dockerfile");
const workflow = read(".github/workflows/package.yml");

test("every package target ships omp, fetched and checked, where the chat server looks", () => {
    assert.match(pack, /fetch-omp\.mjs/);
    assert.match(pack, /join\("omp", ompName\)/);
    // The chat server's lookup is <resources>/omp/omp[.exe] (launch.ts); the two must agree.
    assert.match(read("packages/chat-server/src/agent/launch.ts"), /"omp"/);
    // fetch-omp.mjs exits non-zero on a checksum mismatch, and run() turns that into a refused package.
    assert.match(read("scripts/fetch-omp.mjs"), /sha256/);
    assert.match(pack, /run\(process\.execPath, \[join\(root, "scripts", "fetch-omp\.mjs"\)/);
    // A tree with no binary is not an option any more.
    assert.doesNotMatch(pack, /allow-no-runtime/);
    assert.doesNotMatch(workflow, /allow-no-runtime/);
});

test("nothing in packaging builds or ships a Python runtime", () => {
    assert.doesNotMatch(pack, /agent-runtime|runtime-win32|build-agent-runtime/);
    assert.doesNotMatch(makefile, /agent-runtime/);
    assert.doesNotMatch(workflow, /agent-runtime|setup-uv/);
    assert.doesNotMatch(dockerfile, /^(RUN|COPY|FROM).*(python|uv sync|pip install)/im);
});

test("the image takes omp from deploy/omp.lock for its own architecture and runs unprivileged", () => {
    assert.match(dockerfile, /fetch-omp\.mjs --target "\$target"/);
    assert.match(dockerfile, /amd64\) target=linux-x64/);
    assert.match(dockerfile, /arm64\) target=linux-arm64/);
    assert.match(dockerfile, /OMP_BIN=\/opt\/omp\/omp/);
    assert.match(dockerfile, /^USER 10001:10001$/m);
    assert.match(dockerfile, /^HEALTHCHECK /m);
    assert.match(makefile, /^image:\n\t.*-f deploy\/Dockerfile .*\./m);
});

test("the old rpm tooling is gone: pkgsmith writes the rpm", () => {
    assert.throws(() => read("scripts/make-rpm.mjs"));
    assert.throws(() => read("scripts/copy-runtime-deps.mjs"));
    assert.doesNotMatch(read("package.json"), /electron-installer-redhat/);
    assert.match(read("pkgsmith.star"), /package\(fmt, depends = depends\[fmt\]/);
});

test("every build produces a distinct package", () => {
    /* The release was hardcoded to 1, so every rebuild was pikvm-desktop-1.14.0-1 regardless of
     * what changed inside it, and `dnf install` of a rebuilt package exited 0 having done nothing. */
    assert.match(pack, /rev-list", "--count", "HEAD"/);
    assert.match(pack, /\$\{count\}\.\$\{stamp\}/);
    assert.match(pack, /"--build-arg", `RELEASE=\$\{buildRelease\(\)\}`/);
});

test("electron-builder is started with an argument array, so a tree path with a space survives", () => {
    assert.match(pack, /run\(process\.execPath, \[builderCli\(\), \.\.\.args\]\)/);
    assert.doesNotMatch(pack, /^\s+yarn\(args\);/m);
    // The real CLI parses its arguments before it touches the filesystem, so a split path shows up as
    // "Unknown argument: Desktop-win32-x64" and a whole one as a complaint about the missing directory.
    const { builderCli } = require(resolve(root, "scripts/builder-cli.mjs")) as { builderCli(): string };
    const result = spawnSync(
        process.execPath,
        [builderCli(), "--win", "zip", "--x64", "--prepackaged", "builds/no such dir/PiKVM Desktop-win32-x64", "--publish", "never"],
        { cwd: root, encoding: "utf8", timeout: 60_000 },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, /Unknown argument/);
    assert.notEqual(result.status, 0);
});
