import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { OPERATOR_ID } from "../paths.ts";
import { forgetModels, runtimeListing } from "./service.ts";

/**
 * A stand-in runtime that behaves like omp 18.14: model listing only works when the process has a UI
 * (`--mode rpc-ui`); plain `rpc` answers "ask unavailable". It speaks the real frame format.
 */
const FAKE = `#!/bin/sh
case "$*" in *"--mode rpc-ui"*) UI=1 ;; *) UI= ;; esac
echo '{"type":"ready"}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *negotiate_protocol*) echo "{\\"type\\":\\"response\\",\\"id\\":\\"$id\\",\\"success\\":true,\\"data\\":{}}" ;;
    *get_available_models*)
      if [ -n "$UI" ]; then
        echo "{\\"type\\":\\"response\\",\\"id\\":\\"$id\\",\\"success\\":true,\\"data\\":{\\"models\\":[{\\"id\\":\\"m1\\",\\"name\\":\\"M1\\",\\"provider\\":\\"p\\"}]}}"
      else
        echo "{\\"type\\":\\"response\\",\\"id\\":\\"$id\\",\\"success\\":false,\\"error\\":\\"ask unavailable\\"}"
      fi ;;
  esac
done
`;

let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
    const bin = join(mkdtempSync(join(tmpdir(), "omp-fake-")), "omp");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    process.env.OMP_BIN = bin;
});
afterAll(() => {
    delete process.env.OMP_BIN;
    db.close();
});

describe("model listing", () => {
    it("starts the discovery process with a UI, which omp needs to offer the ask tool", async () => {
        forgetModels();
        const { info } = await runtimeListing(OPERATOR_ID);
        expect(info.models.map((m) => m.id)).toEqual(["m1"]);
    });
});
