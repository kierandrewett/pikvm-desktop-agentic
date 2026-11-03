import { defineConfig } from "vitest/config";

// The end-to-end file starts the real agent binary, so a test may take a while; unit tests are quick.
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        testTimeout: 90_000,
        hookTimeout: 60_000,
        // One server per process: every file gets its own worker, and files do not share module state.
        pool: "forks",
        fileParallelism: false,
    },
});
