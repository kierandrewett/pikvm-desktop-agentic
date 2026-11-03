import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const launcher = readFileSync(resolve(root, "bin/pikvm"), "utf8");
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("one command launches the desktop app", () => {
    assert.equal(pkg.bin?.pikvm, "bin/pikvm");
    // Executable, or `pikvm` is not a command at all.
    assert.ok(statSync(resolve(root, "bin/pikvm")).mode & 0o111, "bin/pikvm is not executable");
    assert.match(launcher, /^#!\/usr\/bin\/env bash$/m);
    assert.match(launcher, /set -euo pipefail/);
    assert.doesNotMatch(launcher, /^\s+cli\)/m);
    assert.match(launcher, /exec "\$\{electron\}" "\$\{root\}\/dist" "\$@"/);
});

test("the launcher says what to do when electron or the build is missing", () => {
    assert.match(launcher, /electron not found/);
    assert.match(launcher, /Run 'yarn build' first/);
});
