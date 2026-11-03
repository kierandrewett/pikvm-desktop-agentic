// Dual esbuild: Node (Electron main + preloads) and the browser haptics module.
import { build } from "esbuild";
import { rmSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Node bundle: the Electron-loaded entry points. Their imports (control core,
//    agent harness, servers, pi-ai, MCP SDK) are bundled in.
await build({
    // Named, so each lands at dist/<name>.js whatever folder it lives in: package.json "main" is
    // main.js and the window loads preload.js from beside it.
    entryPoints: {
        main: resolve(root, "src/main.ts"),
        "mcp-launcher": resolve(root, "src/mcp-launcher.ts"),
        // The headless web host (container deploys). Same server and proxy as
        // the desktop, no Electron import anywhere in its graph.
        "web-server": resolve(root, "src/web-server.ts"),
        // The one preload: window.pikvmDesktop. A preload left off this list is
        // not built, Electron then fails to load it and the window keeps running
        // with the bridge missing, so the window controls quietly do nothing.
        preload: resolve(root, "src/desktop/preload.ts"),
    },
    outdir: dist,
    platform: "node",
    format: "cjs",
    bundle: true,
    // electron is provided by the runtime. sharp is a native module the web image installs beside dist/ (the
    // desktop uses Electron's nativeImage and never loads it).
    //
    // nodejs-whisper and tesseract.js were listed here until the desktop app was
    // slimmed to a pure PiKVM client. Neither is a dependency or installed any
    // more, and nothing imports them; naming them here suggested a build that
    // still handled transcription and local OCR.
    external: ["electron", "sharp"],
    sourcemap: true,
    logLevel: "info",
    // chat-server finds its migrations from import.meta.url only when run from source; the bundle is told where
    // they are (migrationsDir), so the empty import.meta of a CommonJS bundle is never read.
    logOverride: { "empty-import-meta": "silent" },
});

// 2. Static assets and views.
/* The app's package.json, minus the workspace declaration. dist/ is what
   electron-packager and the web image ship; it is not a workspace root, and a
   "workspaces" field there makes package managers look for packages/ and apps/
   that are not in it. @pikvm/contracts is a devDependency because esbuild
   inlines it above, so nothing at runtime needs it installed. */
const { workspaces: _workspaces, ...distPackage } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
writeFileSync(resolve(dist, "package.json"), JSON.stringify(distPackage, null, 4) + "\n");
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
// The chat server's database migrations: the bundle cannot read them from its package folder.
cpSync(resolve(root, "packages/chat-server/migrations"), resolve(dist, "chat-migrations"), { recursive: true });

// 3. Haptics: bundle `web-haptics` into a single ESM module the (un-bundled,
//     statically-served) console dynamically imports as /app/haptics.js.
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
