// Build PiKVM Desktop for one platform and write its packages with pkgsmith.
//
//     node scripts/package.mjs [--platform linux|darwin|win32] [--arch x64|arm64]
//                              [--formats rpm,deb,...] [--skip-build] [--tree-only]
//
// Defaults to this machine's platform and architecture and every format pkgsmith.star writes for
// it. The steps:
//
//   1. yarn build, and the web app's build (skipped with --skip-build).
//   2. electron-packager: the Electron tree for the target, into builds/.
//   3. Fill the tree's resources/ with what the app finds there at run time: the web app, the
//      agent harness UI, the agent runtime and the native terminal addon.
//   4. pkgsmith build over that tree, into builds/packages/<platform>-<arch>/.
//
// Electron trees for another platform are downloaded by electron-packager, so any machine can
// make any tree. What it cannot do is carry the agent runtime across: that is a CPython built for
// one platform, made by `just agent-runtime` on that platform. A tree built without one says so
// and is refused unless --allow-no-runtime is given.
import { packager } from "@electron/packager";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const builds = join(root, "builds");
const log = (message) => console.log(`[package] ${message}`);

const { values: opts } = parseArgs({
    options: {
        platform: { type: "string", default: process.platform },
        arch: { type: "string", default: process.arch },
        formats: { type: "string" },
        "skip-build": { type: "boolean", default: false },
        "tree-only": { type: "boolean", default: false },
        "allow-no-runtime": { type: "boolean", default: false },
    },
});
const platform = opts.platform;
const arch = opts.arch;
if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`unsupported platform ${platform}`);
if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported arch ${arch}`);

const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${platform}-${arch}`;
/** pkgsmith spells the same things differently. */
const PKG_OS = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
const PKG_ARCH = { x64: "amd64", arm64: "arm64" }[arch];

/* The formats each platform's packages come in; keep in step with pkgsmith.star. */
const FORMATS = {
    linux: ["rpm", "deb", "archlinux", "appimage", "flatpak"],
    darwin: ["dmg", "zip"],
    win32: ["msi", "nsis", "zip"],
};

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

/* Every build must be a DIFFERENT package, or fixes do not reach the machine.
 *
 * The release was hardcoded to 1, so every rebuild produced pikvm-desktop-1.14.0-1 no matter
 * what changed inside it. `dnf install ./that.rpm` against an installed 1.14.0-1 does not
 * compare contents: it sees the same name-version-release, says the package is already
 * installed, and exits 0 having done nothing. A rebuilt package with a real fix in it was
 * indistinguishable from a no-op, and stayed uninstalled while everything reported success.
 *
 * So the release is `<commits>.<timestamp>`, which every package manager orders correctly (the
 * leading integer compares numerically) and which is unique per build even when the commit has
 * not moved. `.dirty` marks a package built from uncommitted work so an odd one on disk can be
 * identified later. The commit hash stays out: Arch refuses letters in a pkgrel. */
function buildRelease() {
    const git = (args) => {
        try {
            return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
        } catch {
            return "";
        }
    };
    const count = git(["rev-list", "--count", "HEAD"]) || "0";
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return `${count}.${stamp}${git(["status", "--porcelain"]) ? ".dirty" : ""}`;
}

// ── 1. build ─────────────────────────────────────────────────────────────────────────────────
if (!opts["skip-build"]) {
    run("yarn", ["build"]);
    run("yarn", ["workspace", "@pikvm/web", "build"]);
}
for (const [what, path] of [
    ["the app bundle", join(root, "dist", "main.js")],
    ["the web app", join(root, "apps", "web", "dist", "index.html")],
    ["the harness UI", join(root, "agent", "pikvm_agent", "harness_ui", "index.html")],
]) {
    if (!existsSync(path)) throw new Error(`${what} is not built (${path}); run without --skip-build`);
}

// ── 2. the Electron tree ────────────────────────────────────────────────────────────────────
/* macOS and Windows name the app for people ("PiKVM Desktop.app"); Linux keeps the command-line
 * name, because that is what lands in /usr/bin and in the desktop entry's Exec. */
const productName = "PiKVM Desktop";
const appName = platform === "linux" ? "pikvm-desktop" : productName;

mkdirSync(builds, { recursive: true });
rmSync(join(builds, `${appName}-${target}`), { recursive: true, force: true });
const [tree] = await packager({
    dir: join(root, "dist"),
    name: appName,
    platform,
    arch,
    out: builds,
    overwrite: true,
    asar: false,
    prune: false,
    icon: join(root, "packaging", "icons", "icon"),
    appBundleId: "dev.drewett.pikvm-desktop",
    appCopyright: "Copyright (c) Kieran Drewett",
    appVersion: pkgJson.version,
    darwinDarkModeSupport: true,
    win32metadata: {
        CompanyName: "Kieran Drewett",
        FileDescription: productName,
        ProductName: productName,
        InternalName: "pikvm-desktop",
    },
    ...(platform === "linux" ? { executableName: "pikvm-desktop" } : {}),
});
log(`electron tree: ${tree}`);

// ── 3. resources ─────────────────────────────────────────────────────────────────────────────
const resources = platform === "darwin" ? join(tree, `${appName}.app`, "Contents", "Resources") : join(tree, "resources");

/* main.ts finds these relative to itself (resolve(__dirname, "..", ...)); in the package
 * __dirname is resources/app, so they sit beside it in resources/. The same trick the repo uses
 * (dist/ beside agent/ and apps/), which is why dev and packaged are one code path. */
const place = (from, to) => {
    mkdirSync(dirname(join(resources, to)), { recursive: true });
    cpSync(from, join(resources, to), { recursive: true, dereference: true });
};
place(join(root, "apps", "web", "dist"), join("apps", "web", "dist"));
place(join(root, "agent", "pikvm_agent", "harness_ui"), join("agent", "pikvm_agent", "harness_ui"));
log("shipped the web app and the harness UI");

/* @lydell/node-pty is a prebuilt native addon, one npm package per platform, and esbuild leaves
 * it external. Without it the terminal import throws at runtime; that only shows in the package,
 * never under `yarn start` where the repo's node_modules is still on disk. The platform packages
 * are fetched from the registry for the TARGET, so a tree for another OS gets its own addon. */
async function shipPty() {
    const ptyVersion = JSON.parse(readFileSync(join(root, "node_modules", "@lydell", "node-pty", "package.json"), "utf8")).version;
    const scope = join(resources, "app", "node_modules", "@lydell");
    mkdirSync(scope, { recursive: true });
    cpSync(join(root, "node_modules", "@lydell", "node-pty"), join(scope, "node-pty"), { recursive: true, dereference: true });
    const native = `node-pty-${platform}-${arch}`;
    const installed = join(root, "node_modules", "@lydell", native);
    if (existsSync(installed)) {
        cpSync(installed, join(scope, native), { recursive: true, dereference: true });
        return;
    }
    const meta = await (await fetch(`https://registry.npmjs.org/@lydell/${native}/${ptyVersion}`)).json();
    const tarball = await fetch(meta.dist.tarball);
    if (!tarball.ok) throw new Error(`cannot download @lydell/${native}@${ptyVersion}: ${tarball.status}`);
    const work = join(tmpdir(), `pikvm-pty-${process.pid}`);
    mkdirSync(work, { recursive: true });
    const file = join(work, "pty.tgz");
    writeFileSync(file, Buffer.from(await tarball.arrayBuffer()));
    mkdirSync(join(scope, native), { recursive: true });
    execFileSync("tar", ["-xzf", file, "-C", join(scope, native), "--strip-components=1"]);
    rmSync(work, { recursive: true, force: true });
}
await shipPty();
log(`shipped the terminal addon for ${target}`);

/* The agent runtime: a self-contained CPython with the agent installed into it, built by
 * `just agent-runtime` for the machine it runs on. dereference:false keeps the interpreter's
 * internal symlinks (python3 -> python3.12) as symlinks; following them turns a handful of
 * links into a handful of extra copies of a 100MB binary. */
const runtime = join(root, "agent", "runtime");
const runtimeFits = platform === process.platform && arch === process.arch;
if (existsSync(runtime) && runtimeFits) {
    mkdirSync(join(resources, "agent"), { recursive: true });
    cpSync(runtime, join(resources, "agent", "runtime"), { recursive: true, dereference: false, verbatimSymlinks: true });
    log("shipped the agent runtime");
} else {
    const why = runtimeFits ? "agent/runtime is not built; run `just agent-runtime`" : `agent/runtime is a ${process.platform}-${process.arch} build, not ${target}; build it on a ${target} machine`;
    if (!opts["allow-no-runtime"]) throw new Error(`no agent runtime for ${target}: ${why} (--allow-no-runtime packages the app without an agent)`);
    console.warn(`[package] WARNING: ${why}; this package has NO agent.`);
}

if (opts["tree-only"]) {
    log(`done (tree only): ${tree}`);
    process.exit(0);
}

// ── 4. packages ──────────────────────────────────────────────────────────────────────────────
/** The AppImage runtime (the small ELF the squashfs is appended to), cached beside the builds. */
async function appImageRuntime() {
    const names = { x64: "runtime-x86_64", arm64: "runtime-aarch64" };
    const file = join(builds, ".cache", names[arch]);
    if (!existsSync(file)) {
        const url = `https://github.com/AppImage/type2-runtime/releases/download/continuous/${names[arch]}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`cannot download the AppImage runtime from ${url}: ${res.status}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        chmodSync(file, 0o755);
    }
    return file;
}

const formats = opts.formats ? opts.formats.split(",") : FORMATS[platform];
const outDir = join(builds, "packages", target);
rmSync(outDir, { recursive: true, force: true });
const args = [
    "build",
    "--prefix", tree,
    "-f", join(root, "pkgsmith.star"),
    "-o", outDir,
    "-F", formats.join(","),
    "--build-arg", `PKG_OS=${PKG_OS}`,
    "--build-arg", `PKG_ARCH=${PKG_ARCH}`,
    "--build-arg", `RELEASE=${buildRelease()}`,
    "--progress", "plain",
];
if (platform === "linux" && formats.includes("appimage")) args.push("--build-arg", `APPIMAGE_RUNTIME=${await appImageRuntime()}`);

// PKGSMITH names the binary (a checkout's target/release/pkgsmith, or one on PATH).
const pkgsmith = process.env.PKGSMITH || "pkgsmith";
log(`${pkgsmith} ${args.join(" ")}`);
run(pkgsmith, args);
log(`packages in ${outDir}`);
