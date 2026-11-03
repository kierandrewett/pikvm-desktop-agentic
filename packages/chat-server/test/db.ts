/** A database in a temp directory for unit tests that need settings and nothing else. */
import { rmSync } from "node:fs";
import { seedOperator } from "../src/auth/operator.ts";
import { closeDb, openDb } from "../src/db/index.ts";
import { setAgentBaseUrl } from "../src/env.ts";
import { configurePaths } from "../src/paths.ts";
import { tempDir } from "./temp.ts";

export function useTempDb(): { dir: string; close(): void } {
    const dir = tempDir("chat-unit-");
    configurePaths(dir);
    openDb();
    seedOperator();
    setAgentBaseUrl("http://127.0.0.1:9");
    return {
        dir,
        close() {
            closeDb();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
