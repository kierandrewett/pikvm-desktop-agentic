import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* Resolved against the working directory, not __dirname: the runner bundles
   each test into a temporary directory, so __dirname is not the repo. */

/**
 * The console renderer carries its own copy of the physical keyboard layout.
 *
 * It has to: console.js is a plain browser script served to phones and browsers
 * as well as the desktop, so it cannot import the typing engine's TypeScript.
 * The copy is marked "mirrored from src/human-typing.ts", and until this test
 * that comment was the only thing holding the two together.
 *
 * A drift here is not a rendering glitch. Both sides map a character to a
 * PHYSICAL key code sent over HID, and the target's own layout decides the
 * glyph. If they disagree, a key typed by hand in the console and the same
 * character typed by the agent land on different keys of the remote machine —
 * `"` arriving as `@`, or `\` as `#`. Nothing would report it.
 *
 * Compared as source text because the browser script cannot be imported.
 */

const read = (relative: string) =>
    readFileSync(resolve(process.cwd(), relative), "utf-8");

/** Pull an array literal declared as `var X = [...]` / `const X: T = [...]`. */
function arrayLiteral(source: string, name: string, where: string): string[][] {
    const match = source.match(
        new RegExp(`(?:var|const)\\s+${name}(?::[^=]+)?\\s*=\\s*(\\[[\\s\\S]*?\\]);`),
    );
    assert.ok(match, `${name} not found in ${where}`);
    // Build-time comparison of two checked-in literals, not runtime input.
    const value = eval(match[1]!) as (string | string[])[];
    return value.map((row) => (typeof row === "string" ? row.split("") : row));
}

/** char -> "<KeyCode>|<shift>" for every printable key in the layout. */
function charToKey(rows: string[][], shifted: string[][], codes: string[][]) {
    const map = new Map<string, string>();
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r]!.length; c++) {
            map.set(rows[r]![c]!, `${codes[r]![c]}|false`);
            const upper = shifted[r]![c];
            if (upper) map.set(upper, `${codes[r]![c]}|true`);
        }
    }
    return map;
}

test("the console's US layout is the typing engine's, key for key", () => {
    const console_ = read("src/views/console.js");
    const engine = read("src/human-typing.ts");

    const fromConsole = charToKey(
        arrayLiteral(console_, "ROWS", "console.js"),
        arrayLiteral(console_, "SHIFT_ROWS", "console.js"),
        arrayLiteral(console_, "CODE_ROWS", "console.js"),
    );
    const fromEngine = charToKey(
        arrayLiteral(engine, "ROWS", "human-typing.ts"),
        arrayLiteral(engine, "SHIFT_ROWS", "human-typing.ts"),
        arrayLiteral(engine, "CODE_ROWS", "human-typing.ts"),
    );

    assert.ok(fromConsole.size > 90, "the layout should cover the printable keys");
    assert.deepEqual(
        Object.fromEntries([...fromConsole].sort()),
        Object.fromEntries([...fromEngine].sort()),
    );
});

test("the console's UK overrides are the typing engine's, key for key", () => {
    const console_ = read("src/views/console.js");
    const engine = read("src/human-typing.ts");

    const ukConsole = eval(
        `(${console_.match(/var UK_MAP = (\{[\s\S]*?\});/)![1]})`,
    ) as Record<string, { code: string; shift: boolean }>;

    const block = engine.match(
        /const UK_OVERRIDES = new Map<string, KeyInfo>\(\[([\s\S]*?)\]\);/,
    )![1]!;
    const ukEngine: Record<string, { code: string; shift: boolean }> = {};
    for (const entry of block.matchAll(
        /\[\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*,\s*\{\s*code:\s*"([^"]+)",\s*shift:\s*(true|false)/g,
    )) {
        const char = entry[1] !== undefined ? entry[1] : JSON.parse(`"${entry[2]}"`);
        ukEngine[char] = { code: entry[3]!, shift: entry[4] === "true" };
    }

    // The characters a UK target types on different physical keys from a US one.
    assert.ok(Object.keys(ukEngine).length >= 8, "UK overrides should be present");
    assert.deepEqual(ukConsole, ukEngine);
});
