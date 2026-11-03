import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { paths, OPERATOR_ID } from "../paths.ts";
import { getRow, setValue, SettingsWriteError } from "./store.ts";

let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
});
afterAll(() => db.close());

const key = `users.${OPERATOR_ID}.agent.providers`;

describe("the settings store", () => {
    it("seals provider keys at rest and reads them back, masking nothing for the server", () => {
        setValue(key, { acme: { enabled: true, baseUrl: "https://x.example", api: "openai-completions", apiKey: "sk-at-rest-42", models: [] } }, OPERATOR_ID);
        const raw = new DatabaseSync(paths.db, { readOnly: true }).prepare("select value from settings where key = ?").get(key) as {
            value: string;
        };
        expect(raw.value).not.toContain("sk-at-rest-42");
        expect(raw.value).toContain("v1.");
        expect((getRow(key)!.value as { acme: { apiKey: string } }).acme.apiKey).toBe("sk-at-rest-42");
    });

    it("keeps the stored key when the browser sends the mask back", () => {
        setValue(key, { acme: { enabled: true, baseUrl: "https://x.example", api: "openai-completions", apiKey: "********", models: [] } }, OPERATOR_ID);
        expect((getRow(key)!.value as { acme: { apiKey: string } }).acme.apiKey).toBe("sk-at-rest-42");
    });

    it("reads a ciphertext moved to another key as empty, never as the secret", () => {
        const raw = new DatabaseSync(paths.db).prepare("select value from settings where key = ?").get(key) as { value: string };
        const other = `users.${OPERATOR_ID}.agent.mcp`;
        const moved = (JSON.parse(raw.value) as { acme: { apiKey: string } }).acme.apiKey;
        new DatabaseSync(paths.db)
            .prepare("insert into settings (key, value, source, updated_at) values (?, ?, 'db', 0)")
            .run(other, JSON.stringify({ s: { enabled: true, type: "http", url: "https://m.example", headers: { a: moved } } }));
        const read = getRow(other)!.value as { s: { headers: { a: string } } };
        expect(read.s.headers.a).toBe("");
    });

    it("rejects an unknown key and an invalid value", () => {
        expect(() => setValue("auth.signup", true, OPERATOR_ID)).toThrow();
        expect(() => setValue("system.agent.profile", "full", OPERATOR_ID)).toThrow(SettingsWriteError);
    });
});
