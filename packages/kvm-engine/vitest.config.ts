import { defineConfig } from "vitest/config";

// Pure cores run under node; DOM adapters are tested with an explicit
// `// @vitest-environment jsdom` pragma so the rest stays fast.
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
