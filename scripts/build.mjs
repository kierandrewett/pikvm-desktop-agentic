// Dual esbuild: Node (Electron main + preloads) and browser (React sidebar),
// plus a Tailwind pass for the AI Elements sidebar styles.
import { build } from "esbuild";
import { rmSync, cpSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Node bundle: the Electron-loaded entry points. Their imports (control core,
//    agent harness, servers, pi-ai, MCP SDK) are bundled in.
await build({
    entryPoints: [
        resolve(root, "src/main.ts"),
        resolve(root, "src/preload.ts"),
        resolve(root, "src/preload-ui.ts"),
        resolve(root, "src/preload-sidebar.ts"),
        resolve(root, "src/preload-copilot.ts"),
        resolve(root, "src/ambient/transcriber-worker.ts"),
    ],
    outdir: dist,
    platform: "node",
    format: "cjs",
    bundle: true,
    // nodejs-whisper spawns the whisper.cpp binary it locates via __dirname, and
    // tesseract.js loads its worker/WASM/traineddata from its own package dir — so
    // neither can be bundled; keep them external and resolve from node_modules.
    external: ["electron", "nodejs-whisper", "tesseract.js"],
    sourcemap: true,
    logLevel: "info",
});

// 1b. Headless server bundle: the same control server + runner + proxy, started
//     by src/server-main.ts with plain-Node (non-Electron) implementations. Run
//     with `node dist/server-main.js`. `electron` stays external (it's never
//     reached in the headless path, but a stray transitive import must not be
//     bundled); `sharp` and `nodejs-whisper` are native/__dirname-bound, so they
//     resolve from node_modules at runtime too.
await build({
    entryPoints: [resolve(root, "src/server-main.ts")],
    outfile: resolve(dist, "server-main.js"),
    platform: "node",
    format: "cjs",
    bundle: true,
    external: ["electron", "nodejs-whisper", "sharp"],
    sourcemap: true,
    logLevel: "info",
});

// 2. Static assets and views.
cpSync(resolve(root, "package.json"), resolve(dist, "package.json"));
cpSync(resolve(root, "src/static"), resolve(dist, "static"), { recursive: true });
cpSync(resolve(root, "src/views"), resolve(dist, "views"), { recursive: true });
cpSync(resolve(root, "src/assets"), resolve(dist, "assets"), { recursive: true });

// 3. Browser bundle: the React sidebar, beside its HTML in dist/views.
await build({
    entryPoints: [resolve(root, "src/sidebar/main.tsx")],
    outfile: resolve(dist, "views/sidebar.js"),
    platform: "browser",
    format: "iife",
    bundle: true,
    jsx: "automatic",
    alias: { "@": resolve(root, "src/sidebar") },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".ts": "tsx" },
    sourcemap: true,
    logLevel: "info",
});

// 4. Tailwind: compile the AI Elements / shadcn styles for the sidebar.
execFileSync(
    "npx",
    [
        "@tailwindcss/cli",
        "-i",
        resolve(root, "src/sidebar/styles.css"),
        "-o",
        resolve(dist, "views/sidebar.css"),
        "--minify",
    ],
    { stdio: "inherit", cwd: root },
);

console.log("build complete");
