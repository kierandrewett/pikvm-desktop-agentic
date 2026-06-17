// Dual esbuild: Node (Electron main + preloads) and browser (React sidebar).
import { build } from "esbuild";
import { rmSync, cpSync, mkdirSync } from "fs";
import { resolve } from "path";

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
    ],
    outdir: dist,
    platform: "node",
    format: "cjs",
    bundle: true,
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
});

// 2. Static assets and views.
cpSync(resolve(root, "package.json"), resolve(dist, "package.json"));
cpSync(resolve(root, "src/static"), resolve(dist, "static"), { recursive: true });
cpSync(resolve(root, "src/views"), resolve(dist, "views"), { recursive: true });

// 3. Browser bundle: the React sidebar, beside its HTML in dist/views.
await build({
    entryPoints: [resolve(root, "src/sidebar/main.tsx")],
    outfile: resolve(dist, "views/sidebar.js"),
    platform: "browser",
    format: "iife",
    bundle: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: true,
    logLevel: "info",
});

console.log("build complete");
