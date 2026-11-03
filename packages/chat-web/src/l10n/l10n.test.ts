import { FluentBundle, FluentResource } from "@fluent/bundle";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const src = join(here, "..");
const ftlDir = join(here, "en-GB");

const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return sources(p);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });

const bundle = new FluentBundle("en-GB");
const fileOf = new Map<string, string>();
for (const file of readdirSync(ftlDir).filter((f) => f.endsWith(".ftl"))) {
    const resource = new FluentResource(readFileSync(join(ftlDir, file), "utf8"));
    expect(bundle.addResource(resource, { allowOverrides: false })).toEqual([]);
    for (const entry of resource.body) if ("id" in entry && entry.id) fileOf.set(entry.id, file);
}

/** Message ids written as string literals in `t("id")`, `translate("id")` and `msg("id")` calls. */
const used = new Map<string, string>();
for (const file of sources(src)) {
    const text = readFileSync(file, "utf8");
    for (const [, id] of text.matchAll(/\b(?:t|translate|msg)\(\s*["'`]([a-z][\w-]*)["'`]/g)) {
        if (id && !used.has(id)) used.set(id, file);
    }
}

describe("messages", () => {
    it("every id the Chat code asks for literally exists in en-GB", () => {
        const missing = [...used].filter(([id]) => !bundle.hasMessage(id)).map(([id, file]) => `${id} (${basename(file)})`);
        expect(missing).toEqual([]);
    });

    it("finds the calls it checks (a broken pattern must not pass for an empty check)", () => {
        expect(used.size).toBeGreaterThan(300);
    });

    it("no .ftl file is orphaned: each one has a message the code uses (settings-rows is read through the registry)", () => {
        const files = new Set(readdirSync(ftlDir).filter((f) => f.endsWith(".ftl")));
        const live = new Set([...used.keys()].map((id) => fileOf.get(id)).filter((f): f is string => !!f));
        live.add("settings-rows.ftl");
        expect([...files].filter((f) => !live.has(f))).toEqual([]);
    });
});
