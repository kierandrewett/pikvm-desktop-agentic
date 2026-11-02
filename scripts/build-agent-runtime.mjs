// Build the agent runtime that SHIPS WITH THE APP.
//
// Until this existed, the packaged RPM contained no Python at all — not an
// interpreter, not a venv, not even the pikvm_agent sources. It worked on
// exactly one machine, the one it was built on, because an unrelated checkout in
// the developer's home directory satisfied the last of a list of guesses. On
// anything else the agent had simply never run.
//
// The output is a self-contained directory: a standalone CPython (the same
// python-build-standalone tarball uv manages) with the agent and its core
// dependencies installed INTO it. Not a venv — a venv's pyvenv.cfg points at a
// base interpreter somewhere else on the machine, which is the thing we are
// trying not to depend on.
//
//     agent/runtime/bin/pikvm-agent      <- what main.ts and bin/pikvm look for
//     agent/runtime/bin/python3          <- the interpreter, ours, in the tree
//     agent/runtime/lib/python3.x/site-packages/pikvm_agent/
//
// Core dependencies only. The `vision` extra (paddle, opencv, playwright) is
// roughly 1.2GB on its own and the daemon degrades gracefully without it, so it
// stays an opt-in install rather than something every user downloads.
//
// Relocatable on purpose: the tree gets copied to resources/agent/runtime at
// package time and installed under /usr/lib, so nothing inside may hardcode the
// path it was built at. See writeLauncher() for the one place that matters.
//
// Windows: `--platform win32 --arch x64`, from any host. The interpreter is the standalone Windows
// build, downloaded here (uv only installs for the machine it runs on), and the dependencies are
// the locked set resolved FOR WINDOWS (`uv pip install --python-platform`), wheels only. It lands
// in agent/runtime-win32-x64, not agent/runtime, so a Linux checkout keeps its own runtime. See
// buildWindows() for the layout and why the launcher is an exe.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
    options: {
        platform: { type: "string", default: process.platform },
        arch: { type: "string", default: process.arch },
    },
});
const targetWindows = opts.platform === "win32";
if (targetWindows && opts.arch !== "x64") throw new Error(`no Windows ${opts.arch} runtime: only x64 is built`);
if (!targetWindows && (opts.platform !== process.platform || opts.arch !== process.arch)) {
    throw new Error(
        `a ${opts.platform}-${opts.arch} runtime must be built on that platform (only win32-x64 cross-builds)`,
    );
}

const root = resolve(import.meta.dirname, "..");
const agentDir = join(root, "agent");
const runtimeDir = join(agentDir, targetWindows ? "runtime-win32-x64" : "runtime");

const log = (msg) => console.log(`[agent-runtime] ${msg}`);
const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

/** The interpreter version the agent pins, so this cannot drift from `uv sync`. */
function pinnedPythonVersion() {
    const file = join(agentDir, ".python-version");
    if (!existsSync(file)) throw new Error("agent/.python-version is missing — nothing to pin to");
    return readFileSync(file, "utf8").trim();
}

/**
 * The standalone CPython install root, downloading it if this machine has not
 * seen it yet.
 *
 * `uv python find` prints the interpreter inside a symlinked version-alias
 * directory (…/cpython-3.12-linux…/bin/python3.12), so it is resolved to the
 * real versioned root before copying — otherwise the copy follows a symlink
 * whose name will not match the next patch release.
 */
function standaloneCPython(version) {
    run("uv", ["python", "install", version], { stdio: "inherit" });
    const found = run("uv", ["python", "find", version, "--python-preference", "only-managed"]).trim();
    const real = run("readlink", ["-f", found]).trim();
    return resolve(real, "..", "..");
}

/**
 * A launcher that works wherever the directory ends up.
 *
 * pip writes console scripts with an absolute shebang pointing at the
 * interpreter that installed them. Copy the tree to /usr/lib and that shebang
 * names a path that does not exist on the target machine, and the failure is an
 * inscrutable "bad interpreter" from the kernel rather than anything about the
 * agent. So the generated script is replaced with a POSIX sh wrapper that finds
 * its own directory at runtime and execs the module.
 *
 * A wrapper rather than shebang rewriting: `#!/bin/sh` is the one interpreter
 * path that is stable across every Linux this could land on, and `python -m`
 * needs no entry-point machinery to keep working.
 */
function writeLauncher(dir) {
    const launcher = join(dir, "bin", "pikvm-agent");
    writeFileSync(
        launcher,
        `#!/bin/sh
# Generated by scripts/build-agent-runtime.mjs. Do not edit.
#
# Resolves its own location so the runtime can be copied anywhere — the repo,
# resources/agent/runtime in the packaged app, /usr/lib after an RPM install.
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
# argv[0] is set explicitly because \`python3 -m pikvm_agent.cli\` makes Typer
# print "Usage: python -m pikvm_agent.cli" in every --help and error message,
# which names something the user cannot type.
exec "\${here}/python3" -c 'import sys
sys.argv[0] = "pikvm-agent"
from pikvm_agent.cli import app
app()' "$@"
`,
        "utf8",
    );
    chmodSync(launcher, 0o755);
}

/** Things that cost tens of megabytes and cannot be reached from the daemon. */
const PRUNE = [
    "include", // headers, for building extensions we are not building
    "share", // man pages and terminfo
    "lib/python{V}/test", // CPython's own test suite
    "lib/python{V}/idlelib",
    "lib/python{V}/tkinter", // no Tk in the bundle for it to talk to
    "lib/python{V}/turtledemo",
];

async function pruneRuntime(dir, short) {
    let removed = 0;
    for (const pattern of PRUNE) {
        const target = join(dir, pattern.replace("{V}", short));
        if (!existsSync(target)) continue;
        removed += await directorySize(target);
        rmSync(target, { recursive: true, force: true });
    }
    /* Static libraries only. Bytecode is deliberately NOT pruned any more —
     * see compileEverything(). Deleting it saved a few megabytes and cost
     * seconds on every single launch. */
    for await (const file of walk(dir)) {
        if (file.endsWith(".a")) {
            removed += (await lstat(file)).size;
            rmSync(file, { force: true });
        }
    }
    return removed;
}

async function* walk(dir, { directories = false } = {}) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (directories) yield full;
            yield* walk(full, { directories });
        } else if (!directories) {
            yield full;
        }
    }
}

/* lstat, not stat: bin/python3 -> python3.12 is a symlink, and following it
 * counts a 100MB interpreter twice. The first version of this reported 500MB for
 * a tree `du` measures at 428MB. */
async function directorySize(dir) {
    let total = 0;
    for await (const f of walk(dir)) {
        try {
            total += (await lstat(f)).size;
        } catch {
            /* vanished under us */
        }
    }
    return total;
}

/**
 * Compile every .py to .pyc, once, here.
 *
 * The runtime installs to /usr/lib and runs as the user, so the tree is
 * READ-ONLY at runtime. Python's usual trick of writing __pycache__ next to a
 * module on first import silently fails, which means an uncompiled module is
 * re-parsed and re-compiled on every single launch, forever. Measured on the
 * shipped package: importing pikvm_agent.harness.server took 2.8s with 638 of
 * 4243 files compiled, against 0.95s once the cache was warm. Two processes pay
 * it, the daemon and the harness, and the harness only starts after the daemon
 * is healthy — so it lands twice, in series, on the path to the UI appearing.
 *
 * An earlier version of this script actively DELETED .pyc files as part of the
 * prune, which is where the shortfall came from. It saved a few megabytes.
 *
 * unchecked-hash, not the default timestamp mode: a timestamp .pyc records the
 * source's mtime and recompiles when they disagree. Copying the tree into the
 * package and installing it via rpm does not reliably preserve mtimes, so
 * timestamp-mode caches would be invalidated by packaging itself and the whole
 * exercise would be silently undone. Hash-based caches do not care when the file
 * was written, and `unchecked` skips re-hashing the source on import, which is
 * right for a tree nothing is allowed to edit in place.
 */
function compileEverything(python, dir, short) {
    // -j 0 uses one worker per core. Failures are not fatal: a handful of
    // packages ship py2 or intentionally-broken sample files, and compileall
    // exits non-zero for those while every importable module compiled fine.
    try {
        run(python, [
            "-m", "compileall",
            "-q",
            "-j", "0",
            "--invalidation-mode", "unchecked-hash",
            join(dir, "lib", `python${short}`),
        ], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
        /* see above */
    }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

/** The Windows runtime. Laid out as the standalone Windows Python is (python.exe at the top, Lib/, DLLs/), with
 *  the agent in Lib/site-packages and a launcher, `pikvm-agent.exe`, beside python.exe. */
const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";

/** libarchive's tar: it reads .tar.gz and writes zip on every OS. On Windows that is System32's tar.exe, because
 *  a GNU tar earlier on PATH (Git for Windows) writes neither. */
const BSDTAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";

/** The standalone Windows CPython tarball, downloaded once into ~/.cache. uv lists every platform's URL. */
async function windowsInterpreterArchive(version) {
    const listing = JSON.parse(
        run("uv", ["python", "list", "--all-platforms", "--all-arches", "--only-downloads", "--output-format", "json", version]),
    );
    const found = listing.find(
        (p) => p.implementation === "cpython" && p.os === "windows" && p.arch === "x86_64" && p.variant === "default" && p.url,
    );
    if (!found) throw new Error(`uv knows no standalone Windows x86_64 CPython ${version}`);
    const file = join(homedir(), ".cache", "pikvm-build", decodeURIComponent(found.url.split("/").pop()));
    if (!existsSync(file)) {
        log(`downloading ${found.url}`);
        const res = await fetch(found.url);
        if (!res.ok) throw new Error(`cannot download ${found.url}: ${res.status}`);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    return file;
}

/**
 * pikvm-agent.exe: the launcher pip writes for a console script (distlib's t64.exe, which the Windows
 * Python ships inside pip), then a shebang line, then a zip holding __main__.py.
 *
 * The shebang is `#!<launcher_dir>\python.exe`: the launcher substitutes its own folder, so the exe finds
 * the interpreter beside it wherever the runtime is installed. pip writes an ABSOLUTE path there, which
 * is the Windows version of the failure the sh launcher above exists to avoid. An exe, not a .cmd:
 * Node refuses to spawn a .cmd without a shell, and the app spawns this directly.
 */
function writeWindowsLauncher(dir) {
    const launcher = join(dir, "Lib", "site-packages", "pip", "_vendor", "distlib", "t64.exe");
    if (!existsSync(launcher)) throw new Error(`the Windows Python has no distlib launcher at ${launcher}`);
    const exe = readFileSync(launcher);
    if (!exe.includes(Buffer.from("<launcher_dir>", "utf16le")) && !exe.includes(Buffer.from("<launcher_dir>"))) {
        throw new Error("this distlib launcher does not understand <launcher_dir>; the exe would not be relocatable");
    }
    const work = join(dir, ".launcher-build");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    // argv[0] is set so Typer's usage line names a command the user can type, as the sh launcher does.
    writeFileSync(
        join(work, "__main__.py"),
        'import sys\nsys.argv[0] = "pikvm-agent"\nfrom pikvm_agent.cli import app\napp()\n',
    );
    run(BSDTAR, ["--format", "zip", "-cf", join(work, "main.zip"), "-C", work, "__main__.py"]);
    const out = Buffer.concat([exe, Buffer.from("#!<launcher_dir>\\python.exe\r\n"), readFileSync(join(work, "main.zip"))]);
    writeFileSync(join(dir, "pikvm-agent.exe"), out);
    rmSync(work, { recursive: true, force: true });
}

/** What a complete Windows tree must hold, checked by listing because nothing here can run Windows code. */
function checkWindowsTree(dir, short) {
    const must = [
        "python.exe",
        `python${short.replace(".", "")}.dll`,
        "pikvm-agent.exe",
        join("Lib", "site-packages", "pikvm_agent", "__init__.py"),
        join("Lib", "site-packages", "pikvm_agent", "cli.py"),
        join("Lib", "site-packages", "fastapi", "__init__.py"),
        join("Lib", "os.py"),
        join("DLLs", "_ctypes.pyd"),
    ];
    const missing = must.filter((p) => !existsSync(join(dir, p)));
    if (missing.length) throw new Error(`the Windows runtime is incomplete, missing: ${missing.join(", ")}`);
}

async function buildWindows() {
    const version = pinnedPythonVersion();
    const short = version.split(".").slice(0, 2).join(".");
    log(`building a self-contained Windows x64 runtime for Python ${version}`);

    const archive = await windowsInterpreterArchive(version);
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    // The tarball's top folder is python/; the runtime IS that folder. bsdtar reads a .tar.gz on every OS.
    run(BSDTAR, ["-xf", archive, "-C", runtimeDir, "--strip-components=1"]);
    const sitePackages = join(runtimeDir, "Lib", "site-packages");
    if (!existsSync(join(runtimeDir, "python.exe"))) throw new Error(`no python.exe after unpacking ${archive}`);

    log("exporting the locked dependency set");
    const requirements = join(runtimeDir, "requirements.lock.txt");
    run("uv", [
        "export", "--project", agentDir, "--frozen", "--no-dev", "--extra", "cua",
        "--no-emit-project", "--no-hashes", "--format", "requirements-txt", "-o", requirements,
    ]);

    /* Wheels only, resolved for Windows: nothing here can compile or run a Windows build step. A package with no
     * Windows wheel stops the build and is named by uv. --no-deps because the export is already the whole closure. */
    const target = ["--python-platform", WINDOWS_TRIPLE, "--python-version", version, "--target", sitePackages];
    log("installing locked dependencies for Windows (wheels only)");
    run("uv", ["pip", "install", ...target, "--only-binary", ":all:", "--no-deps", "--no-cache", "-r", requirements], { stdio: "inherit" });
    log("installing the agent itself");
    run("uv", ["pip", "install", ...target, "--no-deps", "--no-cache", agentDir], { stdio: "inherit" });
    rmSync(requirements, { force: true });

    writeWindowsLauncher(runtimeDir);

    let removed = 0;
    for (const p of ["include", "libs", "tcl", join("Lib", "test"), join("Lib", "idlelib"), join("Lib", "tkinter"), join("Lib", "turtledemo")]) {
        const t = join(runtimeDir, p);
        if (!existsSync(t)) continue;
        removed += await directorySize(t);
        rmSync(t, { recursive: true, force: true });
    }
    log(`pruned ${mb(removed)} of headers, import libraries, Tcl and tests`);

    /* Bytecode, as on Linux, so a read-only install does not re-compile every module on every launch. Windows code
     * cannot run here, but CPython 3.12's bytecode is the same on every OS, so the build host's own 3.12 writes it. */
    run("uv", ["python", "install", version], { stdio: "inherit" });
    const host = run("uv", ["python", "find", version]).trim();
    try {
        run(host, ["-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "unchecked-hash", join(runtimeDir, "Lib")], {
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
        /* a few packages ship deliberately broken sample files; everything importable compiled */
    }

    checkWindowsTree(runtimeDir, short);
    log(`ok: ${runtimeDir} (${mb(await directorySize(runtimeDir))}); listing check passed (python.exe, python${short.replace(".", "")}.dll, pikvm-agent.exe, the agent and its dependencies)`);
}

async function main() {
    if (targetWindows) return buildWindows();
    const version = pinnedPythonVersion();
    log(`building a self-contained runtime for Python ${version}`);

    const source = standaloneCPython(version);
    log(`interpreter: ${source}`);

    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    cpSync(source, runtimeDir, { recursive: true, dereference: false, verbatimSymlinks: true });

    const python = join(runtimeDir, "bin", "python3");
    if (!existsSync(python)) throw new Error(`no interpreter at ${python} after copying ${source}`);

    /* The tarball ships PEP 668's EXTERNALLY-MANAGED marker saying "managed by
     * uv, do not modify". True of the copy in ~/.local/share/uv, which other
     * projects share and which uv replaces on upgrade — installing into that one
     * would be exactly the mistake the marker exists to prevent. This is a
     * detached copy that belongs to this build and nothing else reads it, so the
     * claim is no longer true of it and the marker goes with the copy. */
    const short = version.split(".").slice(0, 2).join(".");
    rmSync(join(runtimeDir, "lib", `python${short}`, "EXTERNALLY-MANAGED"), { force: true });

    /* Non-editable on purpose. `uv sync` installs the agent editable, which is
     * right for development and useless here: an editable install is a pointer
     * back to agent/, so the packaged app would depend on a source tree that is
     * not in the package. */
    /* `--system` reads alarmingly and is the correct flag: uv refuses to install
     * into an interpreter that is not a virtualenv unless told, to stop people
     * wrecking /usr/bin/python3. This interpreter is a private copy that was
     * created three lines ago and lives inside the build output, so there is no
     * system to wreck — and a venv here would defeat the point, since its
     * pyvenv.cfg would name a base interpreter outside the bundle. */
    const pip = ["pip", "install", "--python", python, "--system", "--no-cache"];

    /* FROM THE LOCKFILE, in two steps, and this matters more than it looks.
     *
     * `uv pip install agent/` re-resolves from pyproject.toml and ignores
     * uv.lock entirely. The first build of this script did exactly that and
     * shipped mcp 2.0.0 against a lock pinning 1.28.0, because the constraint
     * is `mcp[cli]>=1.2` with no ceiling. mcp 2 moved streamablehttp_client, so
     * the daemon started fine and the harness died on an ImportError the moment
     * it was asked to serve — which presented as the agent UI simply not
     * loading, with a healthy daemon sitting next to it.
     *
     * So: dependencies come from `uv export --frozen`, which is the resolution
     * `uv sync` uses, and the agent itself goes in afterwards with --no-deps so
     * pip cannot quietly re-resolve anything on the way past. The bundled
     * runtime is now the same dependency set as agent/.venv, by construction.
     *
     * --no-dev, and only the `cua` extra: the vision stack is ~1.2GB and the
     * daemon degrades gracefully without it, but `pikvm-agent gui-mcp` (the
     * terminal panel's MCP server, agent/docs/CUA.md) cannot start without
     * cua-agent. torch stays out: pikvm_agent/cua/qwen_shim.py covers the one
     * function cua wanted it for. */
    log("exporting the locked dependency set");
    const requirements = join(runtimeDir, "requirements.lock.txt");
    run("uv", [
        "export",
        "--project", agentDir,
        "--frozen",
        "--no-dev",
        "--extra", "cua",
        "--no-emit-project",
        "--no-hashes",
        "--format", "requirements-txt",
        "-o", requirements,
    ]);

    log("installing locked dependencies");
    run("uv", [...pip, "-r", requirements], { stdio: "inherit" });
    log("installing the agent itself");
    run("uv", [...pip, "--no-deps", agentDir], { stdio: "inherit" });

    writeLauncher(runtimeDir);

    const freed = await pruneRuntime(runtimeDir, short);
    log(`pruned ${mb(freed)} of headers, static libs and tests`);

    log("precompiling bytecode (the installed tree is read-only at runtime)");
    compileEverything(python, runtimeDir, short);

    // Prove it, rather than declaring success because no command threw.
    const help = run(join(runtimeDir, "bin", "pikvm-agent"), ["--help"], { cwd: "/" });
    if (!/pikvm-agent/.test(help)) throw new Error("the built runtime does not run");
    const where = run(python, ["-c", "import pikvm_agent, sys; print(pikvm_agent.__file__)"], { cwd: "/" }).trim();
    if (!where.startsWith(runtimeDir)) {
        throw new Error(`the runtime imports pikvm_agent from ${where}, outside the bundle`);
    }

    /* Import what the HARNESS needs, not just the package root.
     *
     * The daemon and the harness are the same installation but not the same
     * import graph, and a runtime built against the wrong dependency versions
     * starts a perfectly healthy daemon and then dies when the harness is asked
     * to serve. That is what shipped once: mcp 2.0.0 instead of the locked
     * 1.28.0, and the only symptom a user sees is the agent UI never appearing.
     * `pikvm-agent --help` does not touch any of this, so it passed. */
    for (const module of ["pikvm_agent.harness.assistant", "pikvm_agent.harness.general_tools"]) {
        try {
            run(python, ["-c", `import ${module}`], { cwd: "/", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            const detail = String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ");
            throw new Error(`the harness cannot import ${module} in the built runtime: ${detail}`);
        }
    }

    log(`ok: ${runtimeDir} (${mb(await directorySize(runtimeDir))})`);
    log(`verified: runs from / and imports ${where}`);
}

await main();
