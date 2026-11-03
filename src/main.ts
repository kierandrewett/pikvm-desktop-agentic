import { app, shell, dialog, session } from "electron";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { createServer as createProbeServer } from "net";
import { get as httpGet } from "node:http";
import { resolve } from "path";
import { PiKvmControl } from "./pikvm-control";
import { electronImageOps } from "./image-ops-electron";
import { startControlServer, type ControlServer } from "./server";
import { SettingsStore } from "./settings";
import { TargetStore } from "./target-store";
import { createAppWindow, focusAppWindow } from "./desktop/window";

const appIconPath = resolve(__dirname, "assets/icon.png");

// Friendly product name — drives the dock tooltip / WM_CLASS and the about
// panel. Without this, Linux falls back to the package name
// ("pikvm-desktop-agentic") and a generic icon.
app.setName("PiKVM Desktop");

// CRITICAL — must be set BEFORE app is ready. When the agent acts, the transparent
// "agent in control" overlay sits over the console, so Chromium treats the console
// renderer as OCCLUDED and freezes its background timers — including the sidebar's
// /api/state poll. That's why an approval prompt never appeared until you pressed Stop
// (which hides the overlay and wakes the renderer, firing the poll). webPreferences
// backgroundThrottling:false does NOT cover occlusion on Linux/X11; these switches do.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

/** Port for the local control server (MCP + sidebar chat bridge). Overridable via
 *  PIKVM_CONTROL_PORT so a dev build can run alongside an installed instance. */
let CONTROL_PORT = Number(process.env.PIKVM_CONTROL_PORT) || 25650;

/** The first free port at or after `from`.
 *
 *  The single-instance lock stops US colliding with ourselves, but it cannot
 *  help when something else is on 25650 — an orphaned server from a copy that
 *  was killed rather than closed, a dev build run with a different user data
 *  dir, or an unrelated program. Any of those used to be fatal at boot. Walking
 *  up to the next free port costs nothing and every URL in the app is built
 *  from CONTROL_PORT, which is why this has to settle BEFORE anything reads it.
 *
 *  A probe is not a reservation: something could still take the port between
 *  the close here and the real listen. That race is far smaller than the case
 *  this fixes, and the listen error is handled now rather than thrown. */
/* Ports this process has already picked but may not have bound yet.
 *
 * A probe closes its socket before returning, so two probes run back to back
 * both see the same port as free. Remembering what has been handed out keeps
 * two walks from settling on the same port as well as from whatever else is on the box. */
const claimedPorts = new Set<number>();

async function firstFreePort(from: number, host: string, tries = 20): Promise<number> {
    for (let port = from; port < from + tries; port++) {
        if (claimedPorts.has(port)) continue; // ours already, just not bound yet
        const free = await new Promise<boolean>((done) => {
            const probe = createProbeServer();
            probe.once("error", () => done(false));
            probe.once("listening", () => probe.close(() => done(true)));
            probe.listen(port, host);
        });
        if (free) {
            claimedPorts.add(port);
            return port;
        }
    }
    throw new Error(`no free port between ${from} and ${from + tries - 1}`);
}

/** Is something already answering as a PiKVM Desktop on this port?
 *
 *  Distinguishes "another copy of this app is running" from "an orphaned
 *  service, or something unrelated, holds the port". Both make the port walk
 *  happen; only the first means the user may be looking at the wrong window.
 *  Asks for the console the app serves and checks it is really ours rather than
 *  trusting a bare 200 from whatever else might be listening. */
async function anotherDesktopOn(port: number, host: string): Promise<boolean> {
    const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return new Promise((done) => {
        const req = httpGet({ host: target, port, path: "/app/", timeout: 1500 }, (res) => {
            if ((res.statusCode ?? 500) >= 400) {
                res.resume();
                done(false);
                return;
            }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => {
                if (body.length < 4096) body += c;
            });
            res.on("end", () => done(body.includes("PiKVM")));
        });
        req.on("error", () => done(false));
        req.on("timeout", () => {
            req.destroy();
            done(false);
        });
    });
}

/** Whether the control port has already been walked this run. */
let controlPortSettled = false;

/**
 * Pick the port the control server will really use, once, before anything
 * builds a URL out of it.
 *
 * This used to live inside the server start, which is called from
 * createWindow() AFTER createWindow has already built PROXY_ORIGIN from
 * CONTROL_PORT. So when 25650 was taken and the walk moved us to 25652, the
 * window went on loading http://127.0.0.1:25650/app/ and got
 * ERR_CONNECTION_REFUSED forever — the console never appeared at all, while the
 * log cheerfully said the backend was listening on 25652. The old comment said
 * this had to settle "before anything reads it" and it was the one thing that
 * did not.
 *
 * Idempotent, so both callers can ask without racing to walk twice: the second
 * call returns the port the first one settled on.
 */
async function settleControlPort(bindHost: string): Promise<number> {
    if (controlPortSettled) return CONTROL_PORT;
    controlPortSettled = true;
    const wantedPort = CONTROL_PORT;
    CONTROL_PORT = await firstFreePort(wantedPort, bindHost);
    if (CONTROL_PORT === wantedPort) return CONTROL_PORT;
    console.log(`[control] ${wantedPort} is in use, serving on ${CONTROL_PORT} instead`);
    /* Walking the port is not the interesting part. Being the SECOND COPY is.
     *
     * The single-instance lock cannot help against a copy that predates it —
     * it shipped in 1.12.4, so a 1.12.3 still running holds no lock, and a
     * new install starts happily alongside it. That happened: two windows,
     * visually identical, one serving the app and one returning 401
     * from a server orphaned hours earlier. The app knew (it had to walk
     * the port to start at all) and said nothing, so the only way to tell
     * them apart was to go looking at process start times.
     *
     * Only when the port answers as one of US. An orphaned server or an
     * unrelated program holding it is worth a log line and nothing more. */
    if (await anotherDesktopOn(wantedPort, bindHost)) {
        secondInstanceNotice = { wanted: wantedPort, using: CONTROL_PORT };
        console.log(`[control] ${wantedPort} is answering as another PiKVM Desktop — this is a second copy`);
    }
    return CONTROL_PORT;
}

/** Start the PiKVM control core and the control server: the console, the proxy, the chat server and the PiKVM MCP. */
async function startServer(targetStore: TargetStore, settings: SettingsStore) {
    const control = new PiKvmControl(
        {
            ...targetStore.resolve(),
            // Reuse the logged-in PiKVM web session so proxied requests are authorized
            // even when credentials aren't in the URL.
            getCookie: async () => {
                try {
                    const cookies = await session.defaultSession.cookies.get({ name: "auth_token" });
                    return cookies[0]?.value;
                } catch {
                    return undefined;
                }
            },
        },
    );

    // Bind to the LAN only when the user opts in (so a phone/browser can reach
    // the proxy); default to loopback.
    // PIKVM_BIND_HOST overrides the persisted setting (e.g. 0.0.0.0 to test from a
    // phone with a dev build, without flipping the setting the installed app shares).
    const bindHost = process.env.PIKVM_BIND_HOST || settings.get().bindHost || "127.0.0.1";

    await settleControlPort(bindHost);

    const server = startControlServer(
        {
            control,
            settings,
            /* Settings can change the PiKVM from the desktop app. The password goes to its own file and
             * is never returned; the control core follows the new target without a restart, and the
             * Desk (the agent's own link to the Pi) reads it from the control core on its next run. */
            target: {
                view: () => targetStore.view(),
                save: (change) => {
                    const saved = targetStore.save(change);
                    control.setTarget(saved);
                    return targetStore.view();
                },
            },
            images: electronImageOps,
            // A packaged app carries the agent binary in its resources; a dev run finds it by OMP_BIN or PATH.
            ...(app.isPackaged ? { resourcesDir: process.resourcesPath } : {}),
            migrationsDir: resolve(__dirname, "chat-migrations"),
        },
        CONTROL_PORT,
        bindHost,
        (err) => {
            /* Say which port, and say what to do about it. The old behaviour
             * here was an uncaught EADDRINUSE and Electron's raw error box. */
            const busy = err.code === "EADDRINUSE";
            dialog.showErrorBox(
                busy ? "PiKVM Desktop could not start its server" : "PiKVM Desktop server error",
                busy
                    ? `Port ${CONTROL_PORT} on ${bindHost} is already in use, and no free port was found near it.\n\n` +
                      "Another copy of PiKVM Desktop is probably still running. Close it and start this one again, " +
                      "or set a different port with PIKVM_CONTROL_PORT."
                    : `${err.message}\n\nThe local server is not running, so the console will not load.`,
            );
        },
    );
    console.log(`PiKVM backend listening on http://${bindHost}:${CONTROL_PORT} (UI proxy + /app/*)`);
    return server;
}

const configPath = resolve(app.getPath("userData"), "pikvm.json");
function loadConfig() {
    if (!existsSync(configPath)) {
        const cfg = { origin: "https://pikvm/" };
        writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        return cfg;
    }
    return JSON.parse(readFileSync(configPath, "utf-8"));
}
function saveConfig(cfg: any) {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

/** The control server, once started, so quitting can stop the chat server and its agent processes. */
let localServer: ControlServer | null = null;

/** Set when startup found another copy of this app already on our usual port. */
let secondInstanceNotice: { wanted: number; using: number } | null = null;

async function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    // Not config.origin: that may still carry user:pass from an older install. The store reads both.
    const targetStore = new TargetStore(app.getPath("userData"));

    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));

    /* Settle the port FIRST. Everything below is built from it, and until this
     * moved here the window built its origin from the port we hoped for rather
     * than the one we got. */
    await settleControlPort(process.env.PIKVM_BIND_HOST || settings.get().bindHost || "127.0.0.1");
    const LOCAL_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
    // The app can be served from ANYWHERE: set `consoleOrigin` in pikvm.json (or the
    // PIKVM_CONSOLE_ORIGIN env override) to point the desktop at a hosted deployment.
    // When it's not the local server, the desktop is a pure THIN CLIENT: it loads the
    // remote app and does NOT start a local backend (the remote server owns the agent,
    // capture, HID, proxy, etc.).
    const CONSOLE_ORIGIN = (config.consoleOrigin || process.env.PIKVM_CONSOLE_ORIGIN || LOCAL_ORIGIN).replace(/\/$/, "");
    const remoteConsole = CONSOLE_ORIGIN !== LOCAL_ORIGIN;
    const CONSOLE_URL = `${CONSOLE_ORIGIN}/app/`;

    const win = createAppWindow({ url: CONSOLE_URL, icon: appIconPath, version: app.getVersion() });
    const wc = win.webContents;

    // Reveal the window only once the main content has loaded (or after a safety
    // timeout), so there is no flash of an empty/white window on launch.
    let shownOnce = false;
    let consoleLoadFails = 0; // consecutive remote-console load failures
    /* Consecutive LOCAL-console load failures.
     *
     * The local branch retried every 600ms and never stopped, so a console that
     * could not be loaded left an empty window retrying behind it with nothing
     * on screen and nothing in the UI to act on. Measured with the load forced
     * to fail: 34 attempts in 22 seconds, no ceiling, no dialog, no message.
     *
     * The remote branch three lines down already had this right - three tries,
     * then a native dialog. Same failure, two behaviours, and the one with no
     * way out was the DEFAULT path. */
    let localLoadFails = 0;
    /* ~12s of quiet retrying before saying anything. On a cold first boot the
     * server really is still coming up and a dialog would be noise; after that
     * long it is not coming up on its own. */
    const LOCAL_LOAD_MAX_TRIES = 20;
    /* Whether the navigation now finishing is the one that just failed.
     *
     * Chromium loads an error PAGE when a navigation fails, and that error page
     * finishes loading like any other — so did-finish-load fires after
     * did-fail-load, and resetting the counters there zeroed them after every
     * single failure. Both ceilings were therefore unreachable: measured with
     * the load forced to fail, the local branch made 46 attempts in 30 seconds
     * against a limit of 20, and the remote branch's three-try dialog could
     * never have appeared either. Neither counter had ever counted past one. */
    let loadFailedThisAttempt = false;
    const revealWindow = () => {
        if (shownOnce || win.isDestroyed()) return;
        shownOnce = true;
        win.show();
        /* Said once, on the window that can do something about it.
         *
         * After the window is up rather than before, so it is a message about
         * something on screen instead of a box in front of nothing. Cleared as
         * it fires: this is a fact about how the app started, not a condition to
         * keep reporting. */
        const notice = secondInstanceNotice;
        secondInstanceNotice = null;
        if (!notice) return;
        void dialog.showMessageBox(win, {
            type: "warning",
            title: "Another PiKVM Desktop is already running",
            message: `Another copy of PiKVM Desktop is already using port ${notice.wanted}.`,
            detail:
                `This window is running on port ${notice.using} instead, so both are open at once and only this one is using the services it started.\n\n` +
                "That usually means an older copy never quit — most likely one from before the version you just installed, which is why it was not stopped automatically. Close the other window, or quit both and start one again.",
            buttons: ["OK"],
            defaultId: 0,
        });
    };
    wc.on("did-finish-load", () => {
        // Only a load that did NOT fail clears the ceilings. An error page
        // finishing is not the console loading.
        if (!loadFailedThisAttempt) {
            consoleLoadFails = 0;
            localLoadFails = 0;
        }
        setTimeout(revealWindow, 60);
    });
    setTimeout(revealWindow, 4000); // fallback in case load never finishes

    // Start the local backend (the PiKVM control core, the control server with the chat server inside it) —
    // UNLESS we're a thin client pointing at a remote console, where the remote host owns all of it.
    if (!remoteConsole) localServer = await startServer(targetStore, settings);

    const connect = () => {
        console.log("Loading the app at:", CONSOLE_URL);
        loadFailedThisAttempt = false;
        void wc.loadURL(CONSOLE_URL).catch(() => {
            /* did-fail-load below owns the retry and the dialog */
        });
    };

    connect();

    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // ignore sub-resources + aborts
        loadFailedThisAttempt = true; // the error page is about to "finish"
        console.log("Main view failed to load:", errorCode, errorDescription, validatedURL);
        // Local server may just be starting on first boot — keep retrying,
        // but not forever. An empty window that never explains itself is
        // worse than a dialog that does.
        if (!remoteConsole) {
            localLoadFails++;
            if (localLoadFails <= LOCAL_LOAD_MAX_TRIES) {
                setTimeout(connect, 600);
                return;
            }
            localLoadFails = 0;
            // Nothing ever loaded, so the window may never have been shown.
            if (!win.isDestroyed() && !win.isVisible()) win.show();
            void dialog
                .showMessageBox(win, {
                    type: "error",
                    title: "Can't load the console",
                    message: `The console did not load from:\n${CONSOLE_URL}`,
                    detail:
                        (errorDescription || "The local server did not answer.") +
                        "\n\nThis is served by PiKVM Desktop itself, so it usually means the local server did not start. Retrying is worth one try; if it keeps happening the app log has the reason.",
                    buttons: ["Retry", "Quit"],
                    defaultId: 0,
                    cancelId: 1,
                })
                .then((r) => {
                    if (r.response === 0) connect();
                    else app.quit();
                });
            return;
        }
        // REMOTE console unreachable → the user can't reach in-app Settings,
        // so give a NATIVE recovery dialog (independent of the dead frontend).
        consoleLoadFails++;
        if (consoleLoadFails < 3) {
            setTimeout(connect, 1200);
            return;
        }
        consoleLoadFails = 0;
        if (!win.isDestroyed() && !win.isVisible()) win.show();
        void dialog
            .showMessageBox(win, {
                type: "error",
                title: "Can't reach the console",
                message: `Couldn't load the console from:\n${CONSOLE_ORIGIN}`,
                detail: (errorDescription || "The server may be down or the address may be wrong.") + "\n\nUse the local server to get back in.",
                buttons: ["Retry", "Use local server", "Quit"],
                defaultId: 0,
                cancelId: 2,
            })
            .then((r) => {
                if (r.response === 1) {
                    const cfg = loadConfig();
                    delete cfg.consoleOrigin; // back to local
                    saveConfig(cfg);
                    app.relaunch();
                    app.exit(0);
                } else if (r.response === 2) {
                    app.quit();
                } else {
                    connect();
                }
            });
    });

    // Microphone and clipboard for the KVM; full screen and Keyboard Lock for the window
    // controls. Everything else (camera, geolocation, notifications, ...) is refused.
    const allowedPermissions = new Set([
        "media",
        "clipboard-read",
        "clipboard-sanitized-write",
        "clipboard-write",
        "fullscreen",
        "keyboardLock",
    ]);
    session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback) => {
            if (allowedPermissions.has(permission)) {
                callback(true);
            } else {
                console.log(`Blocked permission request: ${permission}`);
                callback(false);
            }
        }
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
        allowedPermissions.has(permission)
    );

    wc.focus();
}

/* One app, one control server.
 *
 * There was no lock, so a second launch was allowed to boot all the way to
 * server.listen() on a port the first copy already held. listen() has no error
 * handler, EADDRINUSE came out as an uncaught exception, and the user got
 * Electron's raw "A JavaScript error occurred in the main process" box with a
 * node:net stack in it. Nothing about that says "it is already running".
 *
 * A second launch is almost always someone trying to get to the window they
 * already have, so hand them that instead of a second copy: two copies would
 * mean two control servers fighting over the same ports and the same runtime files. */
/* Anything that still gets through arrives as a sentence, not a stack.
 *
 * Electron's default for an uncaught exception in the main process is a modal
 * box titled "A JavaScript error occurred in the main process" containing the
 * raw stack — node:net frames and all. It is accurate and useless: it names no
 * cause the user can act on, and it appears before the window does, so there is
 * nothing else on screen to give it context. */
function reportFatal(scope: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fatal] ${scope}: ${message}`);
    try {
        dialog.showErrorBox("PiKVM Desktop hit a problem", `${message}\n\n(${scope})`);
    } catch {
        /* before app ready, or no display — the log line above is the record */
    }
}
process.on("uncaughtException", (err) => reportFatal("uncaught exception", err));
process.on("unhandledRejection", (err) => reportFatal("unhandled rejection", err));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on("second-instance", focusAppWindow);

    // The agent programs are children of this process: stop them before it goes, not after.
    let stopping = false;
    app.on("will-quit", (event) => {
        if (!localServer || stopping) return;
        stopping = true;
        event.preventDefault();
        const done = () => app.exit(0);
        void localServer.shutdown().then(done, done);
        setTimeout(done, 4000).unref();
    });

    app.whenReady().then(() => {
        console.log("Electron ready");
        app.commandLine.appendSwitch("ignore-certificate-errors");

        createWindow().catch((err) => reportFatal("starting the window", err));
    });
}
