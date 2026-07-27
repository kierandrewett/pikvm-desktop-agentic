import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const html = readFileSync(resolve(root, "src/views/console.html"), "utf8");
const css = readFileSync(resolve(root, "src/views/console.css"), "utf8");
const js = readFileSync(resolve(root, "src/views/console.js"), "utf8");

test("desktop opens chat first and never auto-fits around the remote screen", () => {
    assert.match(js, /setPanelTab\("agent"\)/);
    assert.doesNotMatch(js, /autoFitTimer/);
    assert.doesNotMatch(js, /setPanelTab\("terminal"\)/);
});

test("desktop keeps chat primary while the computer preview is collapsible", () => {
    assert.match(css, /grid-column:\s*1;[\s\S]*?\.screen\s*\{[\s\S]*?grid-column:\s*2;/);
    assert.match(css, /\.app\.computer-collapsed/);
    assert.doesNotMatch(css, /\.app\.panel-collapsed/);
    assert.match(html, /aria-label="Hide computer preview"/);
    assert.match(js, /pikvm-chat-workspace-width-v2/);
});

test("desktop keeps healthy status and workspace switching quiet and accessible", () => {
    assert.doesNotMatch(js, /Backend ready/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /role="tablist" aria-label="Workspace"/);
    assert.match(html, /role="tab" aria-selected="true" data-tab="agent"/);
    assert.match(js, /setAttribute\("aria-selected"/);
    assert.match(css, /\.backend-status\[data-state="ready"\] \.bs-text/);
});
