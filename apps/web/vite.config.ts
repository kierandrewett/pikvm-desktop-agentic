import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The web host (or the desktop app's server) the dev server forwards to. Everything the
// app calls that the browser cannot serve itself goes there, so dev behaves like the real
// origin: same paths, same cookies, no CORS.
const target = process.env.PIKVM_WEB_HOST ?? "http://127.0.0.1:8099";

const forward = (ws: boolean) => ({ target, changeOrigin: false, ws });

export default defineConfig({
    base: "/app/",
    plugins: [react(), tailwindcss()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
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
            "/app/workspace": forward(true),
            "/app/harness": forward(true),
            "/api": forward(true),
            "/streamer": forward(false),
            "/janus": forward(true),
            "/oauth2": forward(false),
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test/setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"],
        css: false,
    },
});
