import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* Startup and process lifecycle: how the app claims its ports, what it does
   when it cannot, and how its two local services are reached. Split out of
   desktop-layout.test.ts, which had grown to 121 tests across eight unrelated
   subjects - a file named for the console's layout is not where anyone would
   look for "a listen failure is reported, not thrown". */
const root = process.cwd();
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");

test("a second launch focuses the first instead of crashing on the port", () => {
    // The lock, and a real handler for the launch it turns away.
    assert.match(main, /const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\);/);
    assert.match(main, /if \(!gotSingleInstanceLock\) \{\s*\n\s*app\.quit\(\);/);
    assert.match(main, /app\.on\("second-instance", focusAppWindow\);/);
    const window = readFileSync(resolve(root, "src/desktop/window.ts"), "utf8");
    assert.match(window, /if \(win\.isMinimized\(\)\) win\.restore\(\);[\s\S]*?win\.focus\(\);/);
    // Everything that used to run unconditionally now hangs off holding it.
    const bootstrap = main.slice(main.indexOf("const gotSingleInstanceLock"));
    assert.ok(bootstrap.indexOf("app.whenReady()") > bootstrap.indexOf("} else {"), "whenReady must be inside the lock branch");
});

test("a port already in use is walked past, not fatal", () => {
    assert.match(main, /async function firstFreePort\(from: number, host: string, tries = 20\): Promise<number> \{/);
    // A probe that closes itself, so it never holds what it is testing.
    assert.match(main, /probe\.once\("listening", \(\) => probe\.close\(\(\) => done\(true\)\)\);/);
    assert.match(main, /probe\.once\("error", \(\) => done\(false\)\);/);
    // CONTROL_PORT has to settle BEFORE anything builds a URL from it, and it
    // cannot be a const any more for that to be possible.
    assert.match(main, /^let CONTROL_PORT = Number\(process\.env\.PIKVM_CONTROL_PORT\) \|\| 25650;/m);
    assert.match(main, /CONTROL_PORT = await firstFreePort\(wantedPort, bindHost\);/);
    const start = main.indexOf("CONTROL_PORT = await firstFreePort");
    assert.ok(start > 0, "the port must settle in startup");
    assert.ok(start < main.indexOf("startControlServer("), "the port must settle before the server binds");
});

test("a listen failure is reported, not thrown", () => {
    const server = readFileSync(resolve(root, "src/server/index.ts"), "utf8");
    assert.match(server, /onListenError\?: \(err: NodeJS\.ErrnoException\) => void,/);
    assert.match(server, /server\.on\("error", \(err: NodeJS\.ErrnoException\) => \{[\s\S]*?onListenError\(err\);/);
    // Registered before listen, or the first failure still escapes.
    assert.ok(server.indexOf('server.on("error"') < server.indexOf("server.listen(port, host);"), "the handler must precede listen");
    // And the caller says something a person can act on.
    assert.match(main, /err\.code === "EADDRINUSE"/);
    assert.match(main, /is already in use, and no free port was found near it/);
    // Nothing reaches the user as a bare stack any more.
    assert.match(main, /process\.on\("uncaughtException", \(err\) => reportFatal\("uncaught exception", err\)\);/);
    assert.match(main, /process\.on\("unhandledRejection", \(err\) => reportFatal\("unhandled rejection", err\)\);/);
    assert.match(main, /createWindow\(\)\.catch\(\(err\) => reportFatal\("starting the window", err\)\);/);
});

test("a failed load does not clear the load-failure ceilings", () => {
    assert.match(main, /let loadFailedThisAttempt = false;/);
    // Cleared when a fresh attempt starts...
    assert.match(main, /loadFailedThisAttempt = false;\s*\n\s*void wc\.loadURL\(CONSOLE_URL\)/);
    // ...set the moment one fails, before the error page can "finish"...
    assert.match(main, /loadFailedThisAttempt = true; \/\/ the error page is about to "finish"/);
    // ...and only a clean finish resets either counter.
    assert.match(
        main,
        /if \(!loadFailedThisAttempt\) \{\s*\n\s*consoleLoadFails = 0;\s*\n\s*localLoadFails = 0;\s*\n\s*\}/,
    );
});

test("the local console stops retrying and says so", () => {
    assert.match(main, /const LOCAL_LOAD_MAX_TRIES = 20;/);
    const at = main.indexOf("if (!remoteConsole) {");
    assert.ok(at > 0, "the local branch was not found");
    const branch = main.slice(at, main.indexOf("consoleLoadFails++", at));
    assert.match(branch, /localLoadFails\+\+;/);
    assert.match(branch, /if \(localLoadFails <= LOCAL_LOAD_MAX_TRIES\) \{\s*\n\s*setTimeout\(connect, 600\);/);
    // Nothing ever loaded, so the window may never have been shown.
    assert.match(branch, /if \(!win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.show\(\);/);
    // A dialog that names the URL and offers a way out of both kinds.
    assert.match(branch, /title: "Can't load the console"/);
    assert.match(branch, /buttons: \["Retry", "Quit"\]/);
    assert.match(branch, /if \(r\.response === 0\) connect\(\);\s*\n\s*else app\.quit\(\);/);
});


test("a port handed out once is not handed out again", () => {
    assert.match(main, /const claimedPorts = new Set<number>\(\);/);
    assert.match(main, /if \(claimedPorts\.has\(port\)\) continue; \/\/ ours already, just not bound yet/);
    assert.match(main, /if \(free\) \{\s*\n\s*claimedPorts\.add\(port\);\s*\n\s*return port;\s*\n\s*\}/);
});


test("the control port settles before any URL is built from it", () => {
    /* The walk lived inside the server start, which createWindow() awaits
     * only AFTER it has already built the local origin from CONTROL_PORT. So when
     * 25650 was taken and the walk moved to 25652, the window kept loading
     * http://127.0.0.1:25650/app/ and got ERR_CONNECTION_REFUSED
     * forever - no console at all - while the log said the backend was
     * listening on 25652. Observed, not theorised. */
    const settleAt = main.indexOf("await settleControlPort(");
    const originAt = main.indexOf("const LOCAL_ORIGIN = ");
    assert.ok(settleAt !== -1, "the port is never settled");
    assert.ok(originAt !== -1, "LOCAL_ORIGIN is gone; this test needs rewriting");
    assert.ok(settleAt < originAt, "LOCAL_ORIGIN is built before the port settles");

    // Idempotent, because both createWindow and startServer ask.
    assert.match(main, /if \(controlPortSettled\) return CONTROL_PORT;/);
    // And the walk exists in exactly one place.
    const walks = main.match(/await firstFreePort\(wantedPort/g) ?? [];
    assert.equal(walks.length, 1, "the port walk is duplicated");
});

test("the control server starts whatever else is installed: nothing of the old agent stands in front of it", () => {
    assert.doesNotMatch(main, /agent-runtime|service-manager|ManagedService/);
    const start = main.slice(main.indexOf("async function startServer("), main.indexOf('const configPath = resolve(app.getPath("userData")'));
    // Called straight away, with no early return before it, and given the image ops and the packaged binary's place.
    assert.ok(start.indexOf("startControlServer(") > 0 && !/return\b[^;]*;[\s\S]*startControlServer\(/.test(start.slice(0, start.indexOf("startControlServer("))));
    assert.match(start, /images: electronImageOps,/);
    assert.match(start, /app\.isPackaged \? \{ resourcesDir: process\.resourcesPath \}/);
    assert.match(start, /migrationsDir: resolve\(__dirname, "chat-migrations"\)/);
});

test("quitting stops the chat server and its agent processes before the process goes", () => {
    assert.match(main, /app\.on\("will-quit", \(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?localServer\.shutdown\(\)/);
});
