import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { OPERATOR_ID } from "../paths.ts";
import { buildSpawn, locateRuntime, RuntimeError, setResourcesDir, which } from "./launch.ts";

let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
});
afterAll(() => {
    delete process.env.OMP_BIN;
    db.close();
});

function fakeBinary(dir: string, name = "omp"): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
}

describe("the agent process", () => {
    it("gets an environment built from nothing: none of the host's secrets or PATH", () => {
        process.env.OMP_BIN = fakeBinary(mkdtempSync(join(tmpdir(), "omp-")));
        process.env.PIKVM_PASSWORD = "hunter2";
        process.env.ANTHROPIC_API_KEY = "sk-host";
        try {
            const spec = buildSpawn(OPERATOR_ID, "/tmp", ["--mode", "rpc-ui"], { CHAT_CONVERSATION_ID: "c1" });
            expect(Object.keys(spec.env).sort()).toEqual(
                ["CHAT_CONVERSATION_ID", "HOME", "LANG", "OMP_SKIP_SETUP", "PATH", "PI_NOTIFICATIONS", "TERM"].sort(),
            );
            expect(spec.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
            expect(JSON.stringify(spec)).not.toMatch(/hunter2|sk-host/);
            expect(spec.argv.slice(1, 3)).toEqual(["--config", expect.stringContaining("config.yml")]);
        } finally {
            delete process.env.PIKVM_PASSWORD;
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    it("finds the binary in OMP_BIN, then the packaged resources, then the setting's name on PATH", () => {
        const env = fakeBinary(mkdtempSync(join(tmpdir(), "omp-env-")));
        const resources = mkdtempSync(join(tmpdir(), "omp-res-"));
        const packaged = fakeBinary(join(resources, "omp"));
        process.env.OMP_BIN = env;
        expect(locateRuntime()).toBe(env);
        delete process.env.OMP_BIN;
        setResourcesDir(resources);
        expect(locateRuntime()).toBe(packaged);
        setResourcesDir(undefined);
    });

    it("says what it looked for when there is no runtime", () => {
        process.env.OMP_BIN = "/no/such/omp";
        expect(() => locateRuntime()).toThrow(RuntimeError);
        delete process.env.OMP_BIN;
    });

    it("looks a name up on a PATH without running anything", () => {
        const dir = mkdtempSync(join(tmpdir(), "bin-"));
        const tool = fakeBinary(dir, "sometool");
        expect(which("sometool", dir)).toBe(tool);
        expect(which("missing", dir)).toBeUndefined();
    });
});
