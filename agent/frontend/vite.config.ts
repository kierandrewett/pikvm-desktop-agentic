import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeUiBuildId } from "./scripts/ui-build-id.mjs";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const buildId = await computeUiBuildId(frontendRoot);

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      "@": resolve(frontendRoot, "src"),
    },
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
