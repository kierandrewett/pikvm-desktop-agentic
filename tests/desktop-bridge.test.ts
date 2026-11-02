import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CHANNELS } from "../src/desktop/channels";
import { setDisplayBlocker } from "../src/desktop/display-blocker";
import { externalUrl, navigationVerdict } from "../src/desktop/policy";

const root = process.cwd();
const APP = "http://127.0.0.1:25650/app/";

/* Failure modes of the shell, in the order they would hurt: a page that can make the OS run
   something it should not, a window that wanders off the app, and a bridge that exists on one
   side of the IPC only. */

test("the OS is only ever asked to open web and mail links", () => {
    for (const url of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "smb://host/share",
        "ms-msdt:/id PCWDiagnostic",
        "vscode://x",
        "data:text/html,<b>x</b>",
        "not a url",
        "",
    ]) {
        assert.equal(externalUrl(url), null, url);
    }
    assert.equal(externalUrl("https://example.org/a?b=1"), "https://example.org/a?b=1");
    assert.equal(externalUrl("http://example.org"), "http://example.org/");
    assert.equal(externalUrl("mailto:kieran@drewett.dev"), "mailto:kieran@drewett.dev");
});

test("the window stays on the app's origin, and everything else goes to the browser or nowhere", () => {
    assert.equal(navigationVerdict(APP, "http://127.0.0.1:25650/app/kvm"), "allow");
    assert.equal(navigationVerdict(APP, "http://127.0.0.1:25650/app/settings/connection"), "allow");
    // Another port is another origin, so a stray listener cannot take the window over.
    assert.equal(navigationVerdict(APP, "http://127.0.0.1:25651/app/"), "external");
    assert.equal(navigationVerdict(APP, "https://evil.example/app/"), "external");
    // Our own host under another scheme is another origin too.
    assert.equal(navigationVerdict(APP, "https://127.0.0.1:25650/app/"), "external");
    // Schemes the OS must not be handed.
    assert.equal(navigationVerdict(APP, "file:///etc/passwd"), "block");
    assert.equal(navigationVerdict(APP, "javascript:alert(1)"), "block");
    assert.equal(navigationVerdict(APP, "garbage"), "block");
});

test("kvmd's /api/ is data, not a page, so a navigation there is handed to the browser", () => {
    assert.equal(navigationVerdict(APP, "http://127.0.0.1:25650/api/streamer/snapshot"), "external");
    // Our own API is under /app/, and is not a navigation target either way.
    assert.equal(navigationVerdict(APP, "http://127.0.0.1:25650/app/api/v1/state"), "allow");
});

test("a remote app origin is held to the same rule", () => {
    const remote = "https://kvm.example.org/app/";
    assert.equal(navigationVerdict(remote, "https://kvm.example.org/app/chat"), "allow");
    assert.equal(navigationVerdict(remote, "https://kvm.example.org/oauth2/sign_in"), "allow");
    assert.equal(navigationVerdict(remote, "https://login.example.org/"), "external");
});

test("every channel exists once, and the preload and the main process both use all of them", () => {
    const names = Object.values(CHANNELS);
    assert.equal(new Set(names).size, names.length, "a channel name is used twice");
    const preload = readFileSync(resolve(root, "src/desktop/preload.ts"), "utf8");
    const window = readFileSync(resolve(root, "src/desktop/window.ts"), "utf8");
    for (const key of Object.keys(CHANNELS)) {
        assert.match(preload, new RegExp(`CHANNELS\\.${key}\\b`), `the preload never uses ${key}`);
        assert.match(window, new RegExp(`CHANNELS\\.${key}\\b`), `the main process never uses ${key}`);
    }
});

test("the window is sandboxed, isolated, and loads nothing but the one preload", () => {
    const window = readFileSync(resolve(root, "src/desktop/window.ts"), "utf8");
    assert.match(window, /contextIsolation: true,/);
    assert.match(window, /sandbox: true,/);
    assert.match(window, /nodeIntegration: false,/);
    assert.match(window, /preload: resolve\(__dirname, "preload\.js"\),/);
    // No second window, no second preload, no settings window.
    assert.doesNotMatch(window, /new BrowserWindow\([\s\S]*new BrowserWindow\(/);
    assert.doesNotMatch(window, /WebContentsView/);
    assert.deepEqual(
        readFileSync(resolve(root, "scripts/build.mjs"), "utf8").match(/preload: resolve\(root, "src\/desktop\/preload\.ts"\)/g),
        ['preload: resolve(root, "src/desktop/preload.ts")'],
    );
});

test("the app menu does not steal the target's shortcuts", () => {
    const window = readFileSync(resolve(root, "src/desktop/window.ts"), "utf8");
    assert.match(window, /if \(process\.platform !== "darwin"\) \{\s*\n\s*Menu\.setApplicationMenu\(null\);/);
});

test("main.ts holds no window chrome, settings window or console IPC any more", () => {
    const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
    for (const gone of [
        /ipcMain/,
        /WebContentsView/,
        /preload-console|preload-settings/,
        /console:[a-z-]+/,
        /settings:(read|save|cancel|theme)/,
        /openSettingsWindow/,
        /desktopUseProxy|agent_shell/,
    ]) {
        assert.doesNotMatch(main, gone);
    }
});

/* The display blocker: one per window, never leaked. FAILURE MODES: asking twice starts two (one is
 * then never stopped); stopping when none is held stops something that is not ours; the window's
 * blocker outlives the window. */
test("the display blocker is one per window, released on off and idempotent", () => {
    const started: number[] = [];
    const stopped: number[] = [];
    let next = 100;
    const blocker = {
        start: (type: string) => {
            assert.equal(type, "prevent-display-sleep");
            started.push(next);
            return next++;
        },
        stop: (id: number) => void stopped.push(id),
    };
    setDisplayBlocker(1, true, blocker);
    setDisplayBlocker(1, true, blocker);
    assert.deepEqual(started, [100]);
    setDisplayBlocker(2, true, blocker);
    assert.deepEqual(started, [100, 101]);
    setDisplayBlocker(1, false, blocker);
    setDisplayBlocker(1, false, blocker);
    setDisplayBlocker(3, false, blocker);
    assert.deepEqual(stopped, [100]);
    setDisplayBlocker(2, false, blocker);
    assert.deepEqual(stopped, [100, 101]);
});

test("a window's blocker is released when it closes", () => {
    const window = readFileSync(resolve(root, "src/desktop/window.ts"), "utf8");
    assert.match(window, /win\.on\("closed", \(\) => setDisplayBlocker\(windowId, false, powerSaveBlocker\)\);/);
});
