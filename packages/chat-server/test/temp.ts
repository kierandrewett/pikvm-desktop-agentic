import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A fresh directory for one test run. Under the user's cache, not /tmp: a shared machine's temp cleaner may delete a
 * directory while an agent process is still writing its session file there.
 */
export function tempDir(prefix: string): string {
    const root = process.env.CHAT_TEST_TMP ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pikvm-chat-server-tests");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
}
