import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { scopeChatTheme } from "./scope-chat-theme";
import { startupImagesPlugin } from "./startup-images";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Names this build: the commit (PIKVM_BUILD_ID, which the image build passes in because the image has no
 * .git; otherwise git; otherwise "dev") and the minute-and-second the build ran, so two builds never share
 * an id. It is compiled into the app (__BUILD_ID__, shown in Settings > About) and written to
 * /app/version.json, which an installed app that was put away and brought back compares with its own to
 * learn that a newer build is deployed (src/host/update.ts).
 */
function buildId(): string {
    let commit = process.env.PIKVM_BUILD_ID?.trim();
    if (!commit) {
        try {
            commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        } catch {
            commit = "dev";
        }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
    return `${commit}.${stamp}`;
}

const BUILD_ID = buildId();

// The web host (or the desktop app's server) the dev server forwards to. Everything the
// app calls that the browser cannot serve itself goes there, so dev behaves like the real
// origin: same paths, same cookies, no CORS.
const target = process.env.PIKVM_WEB_HOST ?? "http://127.0.0.1:8099";

const forward = (ws: boolean) => ({ target, changeOrigin: false, ws });

export default defineConfig({
    base: "/app/",
    plugins: [
        react(),
        tailwindcss(),
        scopeChatTheme(),
        startupImagesPlugin(),
        {
            name: "build-id-file",
            generateBundle() {
                this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ build: BUILD_ID })}\n` });
            },
        },
    ],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: true,
        // effect and the contract's HttpApi are most of the bundle; one cached chunk is fine for an
        // app that is loaded once and installed.
        chunkSizeWarningLimit: 800,
    },
    server: {
        proxy: {
            "/app/api": forward(false),
            "/app/legacy": forward(true),
            "/app/chat/api": forward(false),
            "/app/chat/ws": forward(true),
            "/api": forward(true),
            "/streamer": forward(false),
            "/janus": forward(true),
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test/setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"],
        css: false,
        // Cleanup (registered first, in test/setup.ts) must run BEFORE a file's afterEach that unstubs
        // globals: an unmount after matchMedia is gone throws from a late re-render.
        sequence: { hooks: "list" },
    },
});
