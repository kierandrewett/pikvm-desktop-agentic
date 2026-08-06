// Ship the runtime node_modules that the bundle deliberately keeps EXTERNAL.
//
// `scripts/build.mjs` bundles everything except what cannot be bundled: today
// that is @lydell/node-pty, a prebuilt native addon. esbuild leaves it as a bare
// `import("…")`, so it MUST exist in the packaged app's node_modules or the
// import throws at runtime — the failure only shows in the RPM, never in
// `yarn start`, because there the repo's own node_modules is still on disk.
//
// This once also carried nodejs-whisper (whisper.cpp and an STT model),
// tesseract.js and sharp. None of them is a dependency any more, and the header
// here went on describing them long after they went.
//
// electron-packager only copies `dist/`, so here we copy each external plus its full
// (prod + optional) dependency closure into the packaged app's node_modules, AFTER
// packaging and BEFORE the RPM is built. We target the packaged tree directly so the
// repo's dist/ and the headless path (which resolves from the repo root) stay lean.
import { existsSync, readFileSync, cpSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "node_modules");
const dest = join(root, "builds/pikvm-desktop-linux-x64/resources/app/node_modules");

// The bundle's externals, minus electron (the runtime provides that). Their
// transitive deps come along below.
const ROOTS = ["@lydell/node-pty"];

if (!existsSync(join(root, "builds/pikvm-desktop-linux-x64"))) {
    console.error("copy-runtime-deps: packaged app not found — run electron-packager first.");
    process.exit(1);
}

const seen = new Set();
const pkgDir = (name) => {
    const d = join(src, name);
    return existsSync(join(d, "package.json")) ? d : null;
};
function walk(name) {
    if (seen.has(name)) return;
    const dir = pkgDir(name);
    if (!dir) return; // dev/optional dep not installed on this platform — skip
    seen.add(name);
    let pj = {};
    try {
        pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
        /* ignore */
    }
    const deps = { ...(pj.dependencies || {}), ...(pj.optionalDependencies || {}) };
    for (const d of Object.keys(deps)) walk(d);
}
ROOTS.forEach(walk);

mkdirSync(dest, { recursive: true });
for (const name of seen) {
    const from = pkgDir(name);
    if (!from) continue;
    const to = join(dest, name);
    mkdirSync(dirname(to), { recursive: true }); // scoped pkgs (@img/…) need the @scope dir
    cpSync(from, to, { recursive: true, dereference: true });
}

console.log(
    `copy-runtime-deps: shipped ${seen.size} packages into the app: ${[...seen].sort().join(", ")}`,
);

/* The conversation panel's build, which electron-packager also leaves behind.
 *
 * workspace-assets resolves it as `resolve(__dirname, "..", "agent",
 * "pikvm_agent", "harness_ui")`. In the repo __dirname is dist/, so that lands
 * on agent/ at the root and everything works under `yarn start`. In the package
 * __dirname is resources/app, so it looks for resources/agent/… — which nothing
 * ever put there. The server has no fallback: it answers "workspace build not
 * found" with a 404, so the panel was simply dead in the RPM while being
 * perfectly fine in development. The same shape as the native addon above, and
 * the same reason it goes unnoticed.
 *
 * Copied to the path the app already computes rather than changing that path,
 * so dev and packaged stay one code path. */
const uiFrom = join(root, "agent", "pikvm_agent", "harness_ui");
const uiTo = join(root, "builds/pikvm-desktop-linux-x64/resources/agent/pikvm_agent/harness_ui");
if (!existsSync(uiFrom)) {
    console.error("copy-runtime-deps: no workspace build at " + uiFrom + " — run the frontend build first");
    process.exit(1);
}
mkdirSync(dirname(uiTo), { recursive: true });
cpSync(uiFrom, uiTo, { recursive: true, dereference: true });
console.log("copy-runtime-deps: shipped the conversation panel build into resources/agent/");
