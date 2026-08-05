import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const launcher = readFileSync(resolve(root, "bin/pikvm"), "utf8");
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("one command covers the desktop app and the CLI", () => {
    assert.equal(pkg.bin?.pikvm, "bin/pikvm");
    // Executable, or `pikvm` is not a command at all.
    assert.ok(statSync(resolve(root, "bin/pikvm")).mode & 0o111, "bin/pikvm is not executable");
    assert.match(launcher, /^#!\/usr\/bin\/env bash$/m);
    assert.match(launcher, /set -euo pipefail/);
    // `pikvm cli ...` forwards everything through; bare `pikvm` opens the app.
    assert.match(launcher, /^\s+cli\)/m);
    assert.match(launcher, /exec "\$\{exe\}" "\$@"/);
    assert.match(launcher, /exec "\$\{electron\}" "\$\{root\}\/dist" "\$@"/);
});

test("the launcher and the app look for the same agent installation", () => {
    /* A launcher that finds a DIFFERENT install from the app it launches is
     * worse than one that finds nothing: both appear to work, on different
     * builds. The order lives in two languages, so it gets pinned here. */
    // Written out per file rather than through one clever regex: they are two
    // languages, and the thing being pinned is the ORDER, not the syntax.
    const inRepo = { launcher: /\$\{root\}\/agent\/\.venv/, main: /"agent", "\.venv"/ };
    const standalone = /dev\/pikvm-agent\/\.venv/;
    const env = /PIKVM_AGENT_DAEMON_CMD/;

    for (const [name, text, repo] of [
        ["launcher", launcher, inRepo.launcher],
        ["main", main, inRepo.main],
    ] as const) {
        assert.match(text, env, `${name} does not honour the env override`);
        assert.match(text, repo, `${name} does not look in the repo`);
        assert.match(text, standalone, `${name} dropped the standalone checkout`);
        assert.ok(text.search(repo) < text.search(standalone), `${name}: prefers the old checkout`);
    }

    /* Env-before-the-rest is asserted per file rather than by text position: in
     * main.ts the overrides are handed in by the CALLERS, which sit below the
     * function that lists the fixed locations, so position says the opposite of
     * what actually happens. */
    assert.match(main, /return \[\.\.\.preferred, inRepo, standalone\]/);
    assert.ok(launcher.search(env) < launcher.search(inRepo.launcher), "launcher: env is not checked first");

    // And both end on the bare name, so a PATH install still works.
    assert.match(launcher, /printf 'pikvm-agent\\n' # rely on PATH/);
    assert.match(main, /return "pikvm-agent";/);
});

test("the launcher says what to do when there is no agent", () => {
    // Failing with "command not found" from a subprocess tells the user nothing
    // about which of four locations was searched.
    assert.match(launcher, /no agent installation found/);
    assert.match(launcher, /looked in:/);
    assert.match(launcher, /uv sync/);
    assert.match(launcher, /electron not found/);
    assert.match(launcher, /Run 'yarn build' first/);
});
