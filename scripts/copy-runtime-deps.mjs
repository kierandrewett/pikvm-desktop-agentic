// Ship the runtime node_modules that the bundle deliberately keeps EXTERNAL.
//
// `scripts/build.mjs` bundles everything except a few packages that can't be
// bundled because they spawn native binaries / load asset files relative to their
// own package dir (`__dirname`): nodejs-whisper (whisper.cpp + the STT model),
// tesseract.js (OCR worker/WASM/traineddata), and sharp (native libvips). esbuild
// leaves those as bare `import("…")`, so they MUST exist in the packaged app's
// node_modules or the import throws at runtime — which is exactly why transcription
// reported "nodejs-whisper failed to load" in the RPM but worked in `yarn start`.
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

// The bundle's externals (see build.mjs). Their transitive deps come along below.
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

console.log(`copy-runtime-deps: shipped ${seen.size} packages (incl. whisper.cpp + STT model) into the app.`);
