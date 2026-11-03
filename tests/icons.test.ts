import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

/*
 * Phosphor is the only icon set. lucide-react must not appear anywhere in the repo, and no component may draw its
 * own inline <svg> (the icons come from @pikvm/icons).
 */

const root = process.cwd();
const SCANNED_DIRS = ["apps", "src", "packages", "tools"] as const;
/** Inline brand logos are the one allowed use of <svg>; list the files (relative to the repo root) here. */
const SVG_ALLOW_LIST: readonly string[] = [
    // Drawn geometry, not icons: the chat bubble tail, the tailed popover shape and the per-language file glyphs
    // (a Phosphor file outline with a computed badge). None has a Phosphor equivalent.
    "packages/chat-web/src/components/thread/turn.tsx",
    "packages/chat-web/src/ui/tailed-surface.tsx",
    "packages/chat-web/src/components/file-icons/file-type-icon.tsx",
];
const SVG_SCANNED = ["apps/web/src", "packages/chat-web/src"] as const;

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "generated"]);

function* walk(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(path);
        else yield path;
    }
}

const rel = (path: string) => relative(root, path).split("\\").join("/");
const isSource = (path: string) => /\.(ts|tsx)$/.test(path) && !rel(path).endsWith("tests/icons.test.ts");

test("lucide-react is not imported by any TypeScript source", () => {
    const offenders: string[] = [];
    for (const top of SCANNED_DIRS) {
        for (const file of walk(resolve(root, top))) {
            if (!isSource(file)) continue;
            if (readFileSync(file, "utf8").includes("lucide-react")) offenders.push(rel(file));
        }
    }
    assert.deepEqual(offenders, []);
});

test("lucide-react is in no package.json", () => {
    const offenders: string[] = [];
    const manifests = [
        resolve(root, "package.json"),
        ...SCANNED_DIRS.flatMap((top) => [...walk(resolve(root, top))].filter((f) => f.endsWith("/package.json"))),
    ];
    for (const file of manifests) {
        if (readFileSync(file, "utf8").includes("lucide-react")) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, []);
});

test("yarn.lock records no lucide-react", () => {
    const lock = readFileSync(resolve(root, "yarn.lock"), "utf8");
    assert.ok(!lock.includes("lucide-react"));
});

test("no inline <svg> in the app source outside the brand-logo allow-list", () => {
    const offenders: string[] = [];
    for (const dir of SVG_SCANNED) {
        for (const file of walk(resolve(root, dir))) {
            if (!isSource(file) || SVG_ALLOW_LIST.includes(rel(file))) continue;
            if (/<svg[\s>]/.test(readFileSync(file, "utf8"))) offenders.push(rel(file));
        }
    }
    assert.deepEqual(offenders, []);
});
