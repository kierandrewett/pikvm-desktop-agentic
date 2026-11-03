// Build PiKVM Desktop for one platform and write its installers.
//
//     node scripts/package.mjs [--platform linux|darwin|win32] [--arch x64|arm64]
//                              [--formats rpm,deb,...] [--skip-build] [--tree-only]
//
// Defaults to this machine's platform and architecture and every format that platform has. The
// steps:
//
//   1. yarn build, and the web app's build (skipped with --skip-build).
//   2. electron-packager: the Electron tree for the target, into builds/.
//   3. Fill the tree's resources/ with what the app finds there at run time: the web app and omp's
//      standalone binary for the target (the agent runtime), fetched with scripts/fetch-omp.mjs and
//      checked against deploy/omp.lock.
//   4. Installers, into builds/packages/<platform>-<arch>/:
//        linux          pkgsmith build over the tree (pkgsmith.star): rpm, deb, archlinux, appimage, flatpak
//        darwin, win32  electron-builder --prepackaged over the tree (packaging/electron-builder.yml):
//                       dmg and zip; nsis, msi and zip. pkgsmith is only for Linux.
//
// Electron trees for another platform are downloaded by electron-packager, so any machine can
// make any tree, and omp's binary for any target is one download, so the agent travels with it. A tree
// whose omp binary cannot be fetched or does not match its pin is refused. electron-builder's
// installers need their own platform's tools (dmg: macOS; msi: WiX, run under wine off Windows; nsis: its bundled makensis).
import { packager } from "@electron/packager";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { builderCli } from "./builder-cli.mjs";
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
    },
});
const platform = opts.platform;
const arch = opts.arch;
if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`unsupported platform ${platform}`);
if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported arch ${arch}`);

const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${platform}-${arch}`;
/** pkgsmith spells the same things differently; only Linux goes through it. */
const PKG_ARCH = { x64: "amd64", arm64: "arm64" }[arch];

/* The formats each platform's packages come in. Linux: keep in step with pkgsmith.star. macOS and
 * Windows: the electron-builder targets, keep in step with `target` in packaging/electron-builder.yml. */
const FORMATS = {
    linux: ["rpm", "deb", "archlinux", "appimage", "flatpak"],
    darwin: ["dmg", "zip"],
    win32: ["nsis", "msi", "zip"],
};

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
    if (result.status !== 0) {
        const why = result.error?.message ?? `exited ${result.status ?? result.signal}`;
        throw new Error(`${command} ${args.join(" ")}: ${why}`);
    }
}

/* On Windows `yarn` is a .cmd shim, which Node only starts through a shell (since the
 * CVE-2024-27980 fix it refuses .cmd files without one), so spawnSync("yarn") fails with no
 * exit status. Only the build calls use it, and their arguments are fixed words, so the shell
 * cannot split anything. Anything with a path in it (the tree is "PiKVM Desktop-win32-x64") must
 * not go through it: electron-builder is started with Node and an argument array. */
function yarn(args) {
    run("yarn", args, { shell: process.platform === "win32" });
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
    yarn(["build"]);
    yarn(["workspace", "@pikvm/web", "build"]);
}
for (const [what, path] of [
    ["the app bundle", join(root, "dist", "main.js")],
    ["the web app", join(root, "apps", "web", "dist", "index.html")],
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
log("shipped the web app");

/* The agent runtime: omp's standalone binary for this target, at resources/omp/omp[.exe], where the
 * chat server looks (packages/chat-server/src/agent/launch.ts). fetch-omp.mjs downloads it into
 * builds/omp/<version>/<target>, verifies its sha256 against deploy/omp.lock and exits non-zero on
 * a mismatch, which run() turns into a refused package. */
const ompDir = join(builds, "omp", JSON.parse(readFileSync(join(root, "deploy", "omp.lock"), "utf8")).version, target);
run(process.execPath, [join(root, "scripts", "fetch-omp.mjs"), "--target", target, "--out", ompDir]);
const ompName = platform === "win32" ? "omp.exe" : "omp";
place(join(ompDir, ompName), join("omp", ompName));
if (!existsSync(join(resources, "omp", ompName))) throw new Error(`omp was not placed at ${join(resources, "omp", ompName)}`);
log(`shipped omp (${target})`);

if (opts["tree-only"]) {
    log(`done (tree only): ${tree}`);
    process.exit(0);
}

// ── 4. installers ────────────────────────────────────────────────────────────────────────────
const formats = opts.formats ? opts.formats.split(",") : FORMATS[platform];
for (const format of formats) {
    if (!FORMATS[platform].includes(format)) throw new Error(`${platform} has no ${format} package (${FORMATS[platform].join(", ")})`);
}
const outDir = join(builds, "packages", target);
rmSync(outDir, { recursive: true, force: true });

if (platform === "linux") {
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

    const args = [
        "build",
        "--prefix", tree,
        "-f", join(root, "pkgsmith.star"),
        "-o", outDir,
        "-F", formats.join(","),
        "--build-arg", `PKG_ARCH=${PKG_ARCH}`,
        "--build-arg", `RELEASE=${buildRelease()}`,
        "--progress", "plain",
    ];
    if (formats.includes("appimage")) args.push("--build-arg", `APPIMAGE_RUNTIME=${await appImageRuntime()}`);

    // PKGSMITH names the binary (a checkout's target/release/pkgsmith, or one on PATH).
    const pkgsmith = process.env.PKGSMITH || "pkgsmith";
    log(`${pkgsmith} ${args.join(" ")}`);
    run(pkgsmith, args);
} else {
    /* macOS and Windows installers are electron-builder's: it is the tool that knows dmg layout,
     * NSIS and WiX, and the tree it is given is the ordinary Electron one. The macOS tree it takes is
     * the .app itself; the Windows one is the folder. Its output directory defaults to dist/, which
     * is this repo's app bundle, so it is always set. */
    const prepackaged = platform === "darwin" ? join(tree, `${appName}.app`) : tree;
    const args = [
        platform === "darwin" ? "--mac" : "--win",
        ...formats,
        `--${arch}`,
        "--prepackaged", prepackaged,
        "--config", join(root, "packaging", "electron-builder.yml"),
        `--config.directories.output=${outDir}`,
        "--publish", "never",
    ];
    log(`electron-builder ${args.join(" ")}`);
    run(process.execPath, [builderCli(), ...args]);
    /* electron-builder also writes files that are not packages: its debug log whenever it thinks it is
     * debugging (CI=true is enough), and a .blockmap beside every macOS zip, for an updater this
     * app does not have. */
    for (const name of readdirSync(outDir)) {
        if (name === "builder-debug.yml" || name.endsWith(".blockmap")) rmSync(join(outDir, name), { force: true });
    }
}
log(`packages in ${outDir}`);
