import { build } from "esbuild";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = mkdtempSync(join(tmpdir(), "pikvm-desktop-tests-"));

try {
    await build({
        // Discovered, not listed. The entry points used to be written out by
        // hand, so a new tests/*.test.ts file simply never ran and the suite
        // still reported green — which is the one failure mode a test runner
        // must not have.
        entryPoints: readdirSync(resolve(root, "tests"))
            .filter((name) => name.endsWith(".test.ts"))
            .sort()
            .map((name) => resolve(root, "tests", name)),
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
