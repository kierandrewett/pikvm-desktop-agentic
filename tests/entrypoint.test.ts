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
    const bundled = { launcher: /\$\{root\}\/agent\/runtime\/bin/, main: /"agent", "runtime", "bin"/ };
    const inRepo = { launcher: /\$\{root\}\/agent\/\.venv/, main: /"agent", "\.venv"/ };
    const standalone = { launcher: /dev\/pikvm-agent\/\.venv/, main: /"dev", "pikvm-agent"/ };
    const env = /PIKVM_AGENT_DAEMON_CMD/;

    for (const [name, text, ship, repo, old] of [
        ["launcher", launcher, bundled.launcher, inRepo.launcher, standalone.launcher],
        ["main", main, bundled.main, inRepo.main, standalone.main],
    ] as const) {
        assert.match(text, env, `${name} does not honour the env override`);
        assert.match(text, ship, `${name} does not look for the bundled runtime`);
        assert.match(text, repo, `${name} does not look in the repo`);
        assert.match(text, old, `${name} dropped the standalone checkout`);
        // Bundled first: an installed copy must never run a developer's checkout.
        assert.ok(text.search(ship) < text.search(repo), `${name}: prefers a dev venv over the shipped one`);
        assert.ok(text.search(repo) < text.search(old), `${name}: prefers the old checkout`);
    }

    /* Env-before-the-rest is asserted per file rather than by text position: in
     * main.ts the overrides are handed in by the CALLERS, which sit below the
     * function that lists the fixed locations, so position says the opposite of
     * what actually happens. */
    assert.match(main, /configured,\s*\n\s*env,\s*\n\s*bundled:/);
    assert.ok(launcher.search(env) < launcher.search(bundled.launcher), "launcher: env is not checked first");

    /* Neither may end on a bare name. PATH is still a candidate in both, but only
     * after a lookup that actually finds it — `command -v` in the launcher and
     * lookupOnPath() in main. Passing "pikvm-agent" to exec/spawn and letting it
     * fail later is what made a missing runtime look like a broken app. */
    assert.match(launcher, /command -v pikvm-agent 2>\/dev\/null \|\| true/);
    assert.doesNotMatch(launcher, /printf 'pikvm-agent\\n'/);
    assert.match(main, /function lookupOnPath\(name: string\): string \| null/);
    assert.doesNotMatch(main, /return "pikvm-agent";/);
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
