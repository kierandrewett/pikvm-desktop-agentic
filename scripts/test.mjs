import { build } from "esbuild";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = mkdtempSync(join(tmpdir(), "pikvm-desktop-tests-"));

try {
    await build({
        entryPoints: [
            resolve(root, "tests/harness-manager.test.ts"),
            resolve(root, "tests/harness-runtime.test.ts"),
            resolve(root, "tests/harness-view-lifecycle.test.ts"),
            resolve(root, "tests/service-manager.test.ts"),
        ],
        outdir: output,
        platform: "node",
        format: "cjs",
        bundle: true,
        sourcemap: "inline",
        logLevel: "silent",
    });
    const files = readdirSync(output)
        .filter((name) => name.endsWith(".test.js"))
        .map((name) => join(output, name));
    const result = spawnSync(process.execPath, ["--test", ...files], {
        cwd: root,
        stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(output, { recursive: true, force: true });
}
