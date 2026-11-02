// Dual esbuild: Node (Electron main + preloads) and the browser terminal renderer.
import { build } from "esbuild";
import { rmSync, cpSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

/** src/preload*.ts — the scripts Electron injects into a renderer. */
function preloadEntryPoints() {
    return readdirSync(resolve(root, "src"))
        .filter((name) => name.startsWith("preload") && name.endsWith(".ts"))
        .sort()
        .map((name) => resolve(root, "src", name));
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Node bundle: the Electron-loaded entry points. Their imports (control core,
//    agent harness, servers, pi-ai, MCP SDK) are bundled in.
await build({
    entryPoints: [
        resolve(root, "src/main.ts"),
        resolve(root, "src/mcp-launcher.ts"),
        // The headless web host (container deploys). Same server and proxy as
        // the desktop, no Electron import anywhere in its graph.
        resolve(root, "src/web-server.ts"),
        // Every preload, discovered. They used to be listed, and a preload left
        // off the list simply was not built: Electron then fails to load it and
        // the window keeps running with that bridge missing, so the feature it
        // carries quietly does nothing.
        ...preloadEntryPoints(),
    ],
    outdir: dist,
    platform: "node",
    format: "cjs",
    bundle: true,
    // electron is provided by the runtime. @lydell/node-pty is a prebuilt native
    // (.node) addon, so it cannot be bundled and must resolve from node_modules at
    // runtime — scripts/copy-runtime-deps.mjs ships it into the packaged app.
    //
    // nodejs-whisper and tesseract.js were listed here until the desktop app was
    // slimmed to a pure PiKVM client. Neither is a dependency or installed any
    // more, and nothing imports them; naming them here suggested a build that
    // still handled transcription and local OCR.
    external: ["electron", "@lydell/node-pty"],
    sourcemap: true,
    logLevel: "info",
});

// 2. Static assets and views.
cpSync(resolve(root, "package.json"), resolve(dist, "package.json"));
cpSync(resolve(root, "src/static"), resolve(dist, "static"), { recursive: true });
/* Views, minus documentation. src/views is copied wholesale, so a .md written
   beside the files it describes would otherwise be served to browsers and
   packaged into the RPM. VENDOR.md did exactly that the moment it was added.
   Keeping the note next to what it documents is worth more than moving it out
   of the way, so the copy skips it instead. */
cpSync(resolve(root, "src/views"), resolve(dist, "views"), {
    recursive: true,
    filter: (src) => !src.endsWith(".md"),
});
cpSync(resolve(root, "src/assets"), resolve(dist, "assets"), { recursive: true });

// 3a. Terminal renderer (xterm.js) → dist/views/terminal.js, beside its
//     HTML. Plus the xterm stylesheet it needs.
await build({
    entryPoints: [resolve(root, "src/terminal/main.ts")],
    outfile: resolve(dist, "views/terminal.js"),
    platform: "browser",
    format: "iife",
    bundle: true,
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: true,
    logLevel: "info",
});
cpSync(resolve(root, "node_modules/@xterm/xterm/css/xterm.css"), resolve(dist, "views/xterm.css"));
// The PreToolUse guardrail hook ships as a plain script the spawned claude runs.

// 3b. Haptics: bundle `web-haptics` into a single ESM module the (un-bundled,
//     statically-served) console dynamically imports as /_agent/haptics.js.
await build({
    entryPoints: [resolve(root, "src/haptics-entry.js")],
    outfile: resolve(dist, "views/haptics.js"),
    platform: "browser",
    format: "esm",
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: "info",
});

console.log("build complete");
