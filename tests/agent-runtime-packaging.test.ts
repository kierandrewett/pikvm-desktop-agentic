import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* The packaged app shipped no Python for the whole life of the project — no
 * interpreter, no venv, not even the pikvm_agent sources, only the harness_ui
 * bundle. Nothing caught it because nothing asserted the package had to contain
 * an agent, and it "worked" on the build machine via a checkout in the
 * developer's home directory. These tests are that missing assertion. */

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const makefile = read("Makefile");
const pack = read("scripts/package.mjs");
const build = read("scripts/build-agent-runtime.mjs");
const agentIgnore = read("agent/.gitignore");

test("packaging cannot skip building the runtime", () => {
    // A package target that does not depend on the runtime is how you ship an
    // app with no agent and only find out on someone else's machine.
    assert.match(makefile, /^package: agent-runtime\n\tnode scripts\/package\.mjs$/m);
    assert.match(makefile, /^agent-runtime:\n\tnode scripts\/build-agent-runtime\.mjs$/m);
    assert.match(makefile, /^\.PHONY:.*\bagent-runtime\b/m);
});

test("the runtime is copied into the packaged app", () => {
    assert.match(pack, /join\(resources, "agent", "runtime"\)/);
    // dereference:false — python3 -> python3.12 is a symlink, and following it
    // turns one 100MB binary into several.
    assert.match(pack, /dereference: false, verbatimSymlinks: true/);
    // A package without an agent is refused unless asked for, and then says so.
    assert.match(pack, /no agent runtime for \$\{target\}/);
    assert.match(pack, /this package has NO agent/);
});

test("the built runtime is self-contained, not a venv pointing elsewhere", () => {
    /* A venv records its base interpreter in pyvenv.cfg as an absolute path. On
     * the build machine that resolves; on a user's machine it does not, which is
     * the entire failure this replaces. So the interpreter is COPIED in. */
    assert.match(build, /cpSync\(source, runtimeDir/);
    assert.doesNotMatch(build, /uv",\s*\["venv"/);
    // Installed non-editable, or the package would point back at a source tree
    // that is not in the package.
    assert.doesNotMatch(build, /"--editable"/);
    assert.match(build, /"pip", "install", "--python", python/);
});

test("the launcher does not hardcode the path it was built at", () => {
    // pip's console script has an absolute shebang; copy the tree to /usr/lib and
    // it names an interpreter that is not there.
    assert.match(build, /#!\/bin\/sh/);
    assert.match(build, /here=\$\(cd -- "\$\(dirname -- "\$0"\)" && pwd\)/);
    assert.match(build, /exec "\\\$\{here\}\/python3"/);
});

test("the build proves the runtime works instead of assuming it", () => {
    // Every earlier version of this problem was a step that did not throw being
    // read as a step that succeeded.
    assert.match(build, /does not run/);
    assert.match(build, /outside the bundle/);
    assert.match(build, /cwd: "\/"/);
});

test("430MB of build output stays out of git", () => {
    assert.match(agentIgnore, /^runtime\/$/m);
});

test("the old rpm tooling is gone: pkgsmith writes the rpm", () => {
    assert.throws(() => read("scripts/make-rpm.mjs"));
    assert.throws(() => read("scripts/copy-runtime-deps.mjs"));
    assert.doesNotMatch(read("package.json"), /electron-installer-redhat/);
    // pkgsmith writes the rpm itself and never runs rpmbuild, so nothing rewrites the bundled
    // interpreter's shebangs or strips its binaries, which is what the rpmbuild macros used to prevent.
    assert.match(read("pkgsmith.star"), /package\(fmt, depends = depends\[fmt\]/);
});

test("every build produces a distinct package", () => {
    /* The release was hardcoded to 1, so every rebuild was pikvm-desktop-1.14.0-1 regardless of
     * what changed inside it, and `dnf install` of a rebuilt package exited 0 having done nothing. */
    assert.match(pack, /rev-list", "--count", "HEAD"/);
    assert.match(pack, /\$\{count\}\.\$\{stamp\}/);
    assert.match(pack, /"--build-arg", `RELEASE=\$\{buildRelease\(\)\}`/);
});
