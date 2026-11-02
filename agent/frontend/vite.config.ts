import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeUiBuildId } from "./scripts/ui-build-id.mjs";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const buildId = await computeUiBuildId(frontendRoot);

/* The conversation lives in @pikvm/chat-ui, a yarn workspace package, while this
 * host keeps its own npm tree. A bare import inside the package would walk up from
 * packages/chat-ui and find the yarn tree (or nothing); resolving it as though the
 * host had written the import keeps ONE copy of react, assistant-ui and the rest
 * in this bundle, at the versions this package-lock pins. */
const chatUiRoot = resolve(frontendRoot, "../../packages/chat-ui");
const resolveChatUiDependencies = (): Plugin => ({
  name: "pikvm:chat-ui-dependencies",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer?.startsWith(chatUiRoot)) return null;
    if (/^(\.|\/|\0|[a-z]+:)/.test(source) || source.startsWith("@pikvm/")) {
      return null;
    }
    return this.resolve(source, resolve(frontendRoot, "index.html"), {
      ...options,
      skipSelf: true,
    });
  },
});

export default defineConfig({
  plugins: [resolveChatUiDependencies(), react(), tailwindcss()],
  /* Relative, so ONE built bundle works wherever it is mounted. The harness
   * serves it at /app/; the desktop serves the same files from its own origin
   * under /app/workspace/, and an absolute /app/ base would have sent every
   * asset request there to the PiKVM target instead.
   *
   * The cost is that the document must be served at a path ending in "/", or
   * "./app.js" resolves against the parent directory. Hosts redirect to the
   * trailing slash for exactly this reason. */
  base: "./",
  define: {
    __PIKVM_UI_BUILD__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      "@pikvm/chat-ui/ui": resolve(chatUiRoot, "src/ui.ts"),
      "@pikvm/chat-ui": resolve(chatUiRoot, "src/index.ts"),
    },
  },
  server: {
    fs: { allow: [resolve(frontendRoot, "../..")] },
  },
  test: {
    /* The workspace's tests moved with its code; running them here as well
     * proves the package against this host's pinned dependencies, not only
     * against the yarn tree the app builds with. */
    dir: chatUiRoot,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: [resolve(chatUiRoot, "src/test/setup.ts")],
    css: false,
  },
  build: {
    outDir: "../pikvm_agent/harness_ui",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: "oxc",
    chunkSizeWarningLimit: 1_024,
    rollupOptions: {
      /* Two entries from one bundle.
       *
       * `app` is the conversation. `shared` is the same component library —
       * buttons, tooltips, icons — mounted into the PiKVM console itself, so the
       * two halves of the window stop being two different design systems that
       * happen to sit next to each other. They share chunks, so the console does
       * not pay for the whole workspace to get a button. */
      input: {
        app: resolve(frontendRoot, "index.html"),
        shared: resolve(frontendRoot, "src/shared/mount.tsx"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "shared" ? "shared.js" : "app.js",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "styles.css" : "assets/[name][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
});
