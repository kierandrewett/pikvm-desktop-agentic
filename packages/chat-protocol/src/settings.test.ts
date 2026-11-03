import { describe, expect, it } from "vitest";
import { SECRET_MASK, SettingsKeyError, getDef, parseKey, redact, unmask } from "./settings.ts";

describe("settings schema", () => {
    it("refuses the keys the one-operator build dropped", () => {
        for (const key of ["auth.signup", "policy.models.allow", "agent.genui", "system.plugins.enabled"]) {
            expect(() => parseKey(key), key).toThrow(SettingsKeyError);
        }
    });

    it("refuses a partial key and an invalid segment", () => {
        expect(() => parseKey("agent")).toThrow(/overlaps/);
        expect(() => parseKey("agent..mcp")).toThrow(/Invalid key/);
    });

    it("declares the PiKVM agent keys with safe defaults", () => {
        expect(getDef("agent.pikvm.approval")?.default).toBe("risky");
        expect(getDef("agent.pikvm.allowPower")?.default).toBe(false);
        expect(getDef("system.agent.profile")?.default).toBe("computer");
        expect(getDef("system.agent.profile")?.schema.safeParse("full").success).toBe(false);
    });

    it("masks provider keys on read and restores them when the mask comes back", () => {
        const def = getDef("agent.providers")!;
        const stored = { acme: { apiKey: "sk-real", baseUrl: "http://x" } };
        const shown = redact(def, stored) as typeof stored;
        expect(shown.acme.apiKey).toBe(SECRET_MASK);
        expect((unmask(def, shown, stored) as typeof stored).acme.apiKey).toBe("sk-real");
    });
});
