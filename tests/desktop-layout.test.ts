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

test("desktop keeps chat primary while the target preview is collapsible", () => {
    assert.match(css, /grid-column:\s*1;[\s\S]*?\.screen\s*\{[\s\S]*?grid-column:\s*2;/);
    assert.match(css, /\.app\.computer-collapsed/);
    assert.doesNotMatch(css, /\.app\.panel-collapsed/);
    assert.match(html, /aria-label="Hide target preview"/);
    assert.match(js, /pikvm-chat-workspace-width-v2/);
});

test("desktop keeps healthy status quiet and accessible", () => {
    assert.doesNotMatch(js, /Backend ready/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(css, /\.backend-status\[data-state="ready"\] \.bs-text/);
});

test("VNC lab targets use the snapshot screen transport", () => {
    const consolePure = require(resolve(root, "src/views/console.js"));

    assert.equal(
        consolePure.streamModeForInfo({
            result: { extras: { vnc_lab: { enabled: true } } },
        }),
        "snapshot",
    );
    assert.equal(consolePure.streamModeForInfo({ result: { extras: {} } }), "native");
    assert.match(js, /\/api\/streamer\/snapshot/);
});

test("the panel divider offers only widths the grid will actually render", () => {
    const { panelCeiling } = require(resolve(root, "src/views/console.js"));

    // At the 900px minimum window the grid keeps 300px for the screen, so the
    // panel tops out at 600 — announcing --chat-max here would promise 1100 and
    // leave the last 500px of the drag moving nothing.
    assert.equal(panelCeiling(900, 300, 320, 1100), 600);
    // Wide enough and the static ceiling is the binding one again.
    assert.equal(panelCeiling(1600, 300, 320, 1100), 1100);
    assert.equal(panelCeiling(1400, 300, 320, 1100), 1100);
    assert.equal(panelCeiling(1399, 300, 320, 1100), 1099);
    // Never below the floor, even if the viewport is nonsense or not yet known.
    assert.equal(panelCeiling(400, 300, 320, 1100), 320);
    assert.equal(panelCeiling(0, 300, 320, 1100), 320);
    assert.equal(panelCeiling(undefined, 300, 320, 1100), 320);

    // The reserve is a shared token, so the drag and the grid cannot drift.
    assert.match(css, /--screen-min:\s*300px/);
    assert.doesNotMatch(css, /calc\(100vw - 300px\)/);
    assert.match(js, /aria-valuemax", String\(panelMaxNow\(\)\)/);
});

test("collapsing the preview retires the divider instead of hiding it off-screen", () => {
    // It is absolutely positioned against the conversation, so with the preview
    // collapsed it sits half off the window edge. Visually gone is not enough —
    // it stayed focusable, and one arrow press there rewrote the saved width.
    assert.match(
        css,
        /\.app\.computer-collapsed \.chat-resize\s*\{\s*display:\s*none/,
    );
    // The collapse changes the conversation's width, and the divider announces
    // that width, so the toggle has to repaint it on the way back out.
    assert.match(js, /repaintPanelDivider\(\)/);
    assert.match(js, /repaintPanelDivider = paintResizeValue/);
    // aria-valuenow is clamped into the announced range, so now > max cannot happen.
    assert.match(js, /aria-valuenow",\s*String\(clampPanelWidthNow\(/);
});

test("screen failures keep the last frame and offer a deliberate retry", () => {
    assert.match(html, /alt="Remote target screen"/);
    assert.match(html, /id="overlay-retry"/);
    assert.doesNotMatch(html, /class="spinner"/);
    assert.match(js, /Screen preview unavailable/);
    assert.match(css, /\.screen\.has-frame \.overlay/);
});
