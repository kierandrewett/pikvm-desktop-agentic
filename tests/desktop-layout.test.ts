import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const html = readFileSync(resolve(root, "src/views/console.html"), "utf8");
const css = readFileSync(resolve(root, "src/views/console.css"), "utf8");
const js = readFileSync(resolve(root, "src/views/console.js"), "utf8");
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
const preload = readFileSync(resolve(root, "src/preload-console.ts"), "utf8");

test("desktop exposes one chat workspace and never auto-fits around the remote screen", () => {
    assert.doesNotMatch(html, /role="tablist" aria-label="Workspace"/);
    assert.doesNotMatch(html, />Terminal<\/button>/);
    assert.doesNotMatch(js, /setPanelTab\(/);
    assert.doesNotMatch(preload, /setPanelTab/);
    assert.doesNotMatch(main, /const terminalView = new WebContentsView/);
    assert.doesNotMatch(main, /console:panel-tab/);
    assert.doesNotMatch(js, /autoFitTimer/);
});

test("desktop keeps chat primary while the computer preview is collapsible", () => {
    assert.match(css, /grid-column:\s*1;[\s\S]*?\.screen\s*\{[\s\S]*?grid-column:\s*2;/);
    assert.match(css, /\.app\.computer-collapsed/);
    assert.doesNotMatch(css, /\.app\.panel-collapsed/);
    assert.match(html, /aria-label="Hide computer preview"/);
    assert.match(js, /pikvm-chat-workspace-width-v2/);
});

test("desktop keeps healthy status quiet and accessible", () => {
    assert.doesNotMatch(js, /Backend ready/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(css, /\.backend-status\[data-state="ready"\] \.bs-text/);
});
