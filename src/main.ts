import { app, shell, dialog, session } from "electron";
import {
    chmodSync,
    readFileSync,
    existsSync,
    mkdirSync,
    writeFileSync,
} from "fs";
import { createServer as createProbeServer } from "net";
import { get as httpGet } from "node:http";
import { resolve, isAbsolute } from "path";
import {
    agentExecutablePaths,
    describeAgentRuntime,
    resolveAgentRuntime,
    type AgentRuntimeResolution,
} from "./agent-runtime";
import { parseEndpoint, unixEndpointValue } from "./endpoint";
import { PiKvmControl } from "./pikvm-control";
import { electronImageOps } from "./image-ops-electron";
import { startControlServer } from "./server";
import { SettingsStore } from "./settings";
import { TargetStore } from "./target-store";
import { ManagedService } from "./service-manager";
import { HarnessManager } from "./harness-manager";
import { activeManagedClientRuntimePath } from "./harness-runtime";
import { WORKSPACE_PREFIX } from "./server/workspace";
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
 * both see the same port as free. The control server, the daemon and the
 * harness all walk from their own defaults, and the first run of this handed
 * the daemon and the harness the SAME port:
 *
 *     [daemon]  127.0.0.1:47615 is in use, using http://127.0.0.1:47617
 *     [harness] 127.0.0.1:47616 is in use, using http://127.0.0.1:47617
 *
 * which is a worse failure than the orphaned port it was written to route
 * around. Remembering what has been handed out is what makes the walks
 * independent of each other as well as of whatever else is on the box. */
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

/** Where the pikvm-agent runtime might be, best candidate first.
 *
 *  Both paths are computed from __dirname the same way, so development and the
 *  packaged app are ONE code path: in the repo __dirname is dist/ and these land
 *  on agent/ at the root; in the package __dirname is resources/app and they
 *  land on resources/agent/. That is the same trick copy-runtime-deps.mjs uses
 *  to place harness_ui, and it is why nothing here needs to know which it is.
 *
 *  The daemon and the harness are the SAME installation, so there is one list
 *  and both go through it. Two copies of a preference order is how the two end
 *  up launching different builds the day one gains a candidate the other lacks.
 *
 *  Two places, and an override for anywhere else. The retired ~/dev/pikvm-agent
 *  checkout used to sit on the end of this list; it is gone, so `agent/` in this
 *  tree is the only thing that can run. */
function agentRuntime(...preferred: (string | undefined)[]): AgentRuntimeResolution {
    const [configured, ...env] = preferred;
    return resolveAgentRuntime(
        {
            configured,
            env,
            ...agentExecutablePaths(resolve(__dirname, "..", "agent")),
        },
        { exists: existsSync },
    );
}

/** Tell the operator the agent is unavailable, and exactly what to do.
 *
 *  Every path that cannot find a runtime comes through here, so the message is
 *  written once. It names what was looked for, because "not found" without the
 *  list is the same dead end the old silent fallback produced. */
function reportMissingAgentRuntime(r: AgentRuntimeResolution): void {
    if (r.found) return;
    console.error(describeAgentRuntime(r));
    dialog.showErrorBox(
        "PiKVM Desktop could not start its agent",
        `${r.hint}\n\nLooked in:\n${r.tried.map((t) => `  ${t}`).join("\n")}\n\n` +
            "The KVM view and the console work without it. Only the agent (the Chat tab) is unavailable.",
    );
}

/** Resolve the runtime that launches the pikvm-agent daemon. */
function resolveDaemonRuntime(configured?: string): AgentRuntimeResolution {
    return agentRuntime(configured, process.env.PIKVM_AGENT_DAEMON_CMD);
}

/** Resolve the same pikvm-agent installation for the first-party harness. */
function resolveHarnessRuntime(configured?: string): AgentRuntimeResolution {
    return agentRuntime(configured, process.env.PIKVM_HARNESS_CMD, process.env.PIKVM_AGENT_DAEMON_CMD);
}

function resolvedHarnessOrigin(): string {
    return (process.env.PIKVM_HARNESS_ORIGIN || "http://127.0.0.1:47616").replace(
        /\/$/,
        "",
    );
}

/* Where the two LOCAL services listen by default: a socket in a directory we
 * own, not a fixed loopback port.
 *
 * The daemon and the harness are ours — we spawn them, and both refuse
 * credential-blind adoption — so a fixed port bought them nothing and cost the
 * usual thing: an orphan of a previous run holding 47615 or 47616, this app
 * correctly refusing to talk to it, and the port walk above having to route
 * around it. A socket cannot be squatted by anything that does not have this
 * directory, and the directory is ours.
 *
 * NOT the control server, which stays on TCP and binds 0.0.0.0 on purpose: a
 * phone on the LAN loads the console from it, and there is no URL a browser can
 * put in its address bar that reaches a unix socket.
 *
 * uvicorn's --uds needs AF_UNIX, which CPython does not have on Windows, so the
 * port walk remains the answer there. */
const LOCAL_SOCKETS_SUPPORTED = process.platform !== "win32";

/** The private directory holding this app's service sockets.
 *
 *  0700 because it is the only boundary there is: uvicorn chmods a socket to
 *  0666 AFTER binding it, so the socket's own mode is not ours to set. The
 *  bearer tokens are still the real check; this stops the socket from even
 *  being openable by another user on the box. We may set the mode because we
 *  chose the path — the daemon may not, since it can be handed /tmp. */
function serviceSocketDirectory(settings: SettingsStore): string {
    const directory = resolve(settings.dir(), "run");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    return directory;
}

/** `unix:<directory>/<name>`, or null if that path is too long to bind.
 *
 *  sun_path holds 108 bytes on Linux and 104 on macOS, NUL included. Past that
 *  the bind fails inside uvicorn with an errno nobody would trace back to a
 *  long settings directory, so the caller falls back to a port instead. */
function socketEndpoint(directory: string, name: string): string | null {
    const path = resolve(directory, name);
    if (Buffer.byteLength(path) > 100) {
        /* Said out loud, because the fallback is otherwise invisible: the first
         * real run of this used a settings directory 118 bytes deep and quietly
         * went back to ports, which looks exactly like the socket work not
         * having landed. */
        console.log(
            `[sockets] ${path} is ${Buffer.byteLength(path)} bytes, too long for a unix socket — using a port instead`,
        );
        return null;
    }
    return unixEndpointValue(path);
}

/** The same loopback origin, moved to the first free port at or after its own.
 *
 *  A no-op in the ordinary case, where the default port is free and this
 *  returns exactly what it was given. */
async function originOnFreePort(name: string, origin: string): Promise<string> {
    const url = new URL(origin);
    const wanted = Number(url.port);
    if (!wanted) return origin.replace(/\/$/, "");
    const free = await firstFreePort(wanted, url.hostname);
    if (free === wanted) return origin.replace(/\/$/, "");
    url.port = String(free);
    const moved = url.toString().replace(/\/$/, "");
    console.log(`[${name}] ${url.hostname}:${wanted} is in use, using ${moved} instead`);
    return moved;
}

/** Start the PiKVM backend, first-party harness, and local console proxy. */
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
        const req = httpGet({ host: target, port, path: `${WORKSPACE_PREFIX}/`, timeout: 1500 }, (res) => {
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
 * This used to live inside startProxyAndHarness(), which is called from
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
     * visually identical, one serving the agent panel and one returning 401
     * from a harness orphaned hours earlier. The app knew (it had to walk
     * the port to start at all) and said nothing, so the only way to tell
     * them apart was to go looking at process start times.
     *
     * Only when the port answers as one of US. An orphaned daemon or an
     * unrelated program holding it is worth a log line and nothing more. */
    if (await anotherDesktopOn(wantedPort, bindHost)) {
        secondInstanceNotice = { wanted: wantedPort, using: CONTROL_PORT };
        console.log(`[control] ${wantedPort} is answering as another PiKVM Desktop — this is a second copy`);
    }
    return CONTROL_PORT;
}

async function startProxyAndHarness(
    targetStore: TargetStore,
    settings: SettingsStore,
    harnessRuntime: AgentRuntimeResolution,
) {
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
        electronImageOps,
    );

    // Apply persisted preferences that the proxy/control core honours.
    const s = settings.get();
    control.setLayout(s.keyboardLayout, { source: "auto" }); // let the Pi's hid_keymaps refine this saved default

    // Bind to the LAN only when the user opts in (so a phone/browser can reach
    // the proxy); default to loopback.
    // PIKVM_BIND_HOST overrides the persisted setting (e.g. 0.0.0.0 to test from a
    // phone with a dev build, without flipping the setting the installed app shares).
    const bindHost = process.env.PIKVM_BIND_HOST || settings.get().bindHost || "127.0.0.1";

    await settleControlPort(bindHost);

    // The desktop owns both local services and creates two non-interchangeable
    // daemon capabilities. Guarded-direct clients receive only the action
    // capability; the harness-only approval capability stays in child env.
    /* Our own default is a socket now; see LOCAL_SOCKETS_SUPPORTED.
     *
     * Everything below still applies to the fallbacks — a Windows build, or a
     * settings directory too long for sun_path — and to an explicitly
     * configured TCP origin, which is why none of it has gone. */
    const socketDirectory = LOCAL_SOCKETS_SUPPORTED
        ? serviceSocketDirectory(settings)
        : null;
    /* Walk past a port some stranger already holds — but only our OWN default.
     *
     * These two are ours: we spawn them, and the daemon is configured
     * adoptExisting:false precisely so we never talk to one whose credential we
     * cannot prove. That refusal was correct and the outcome was not: a harness
     * left behind by a previous run still owned 47616, the fresh token this run
     * generated was not the one it was started with, and every workspace call
     * came back 401 while the app could not spawn its own on a taken port.
     * Observed with an app started at 14:30 and a harness surviving from 20:33
     * the night before.
     *
     * Moving to the next free port routes around the orphan instead of losing
     * to it. Only when the value is our built-in default: a URL that came from
     * PIKVM_AGENT_DAEMON, PIKVM_HARNESS_ORIGIN or Settings is a deliberate
     * instruction about where the service lives, and wandering off it would be
     * ignoring the user rather than helping them. */
    const configuredDaemon = process.env.PIKVM_AGENT_DAEMON || settings.get().daemonUrl;
    const daemonSocket = socketDirectory && socketEndpoint(socketDirectory, "daemon.sock");
    const daemonOrigin = configuredDaemon
        ? configuredDaemon.replace(/\/$/, "")
        : daemonSocket || (await originOnFreePort("daemon", "http://127.0.0.1:47615"));
    /* The harness walks too, now that its child can be told where to go.
     *
     * This used to be pinned, because the harness takes its bind address from
     * the YAML that ensureConfig() writes only when the file does not already
     * exist — so on any install that had run once, choosing a different origin
     * here left the app waiting on one port while the child charged at the old
     * one, the same "[Errno 98] address already in use" crash loop the daemon
     * had before it was told its port. `harness serve --listen HOST:PORT` closes
     * that gap: one run's bind, no rewrite of a config file that carries the
     * operator's provider settings.
     *
     * This is the failure that took the agent panel down — a harness left over
     * from a previous run owning the port, an app that correctly refuses
     * credential-blind adoption, and no way to put its own harness anywhere
     * else. Same rule as the daemon: only our own default walks, because a URL
     * from PIKVM_HARNESS_ORIGIN is an instruction about where the service lives. */
    const harnessSocket = socketDirectory && socketEndpoint(socketDirectory, "harness.sock");
    const harnessOrigin = process.env.PIKVM_HARNESS_ORIGIN
        ? resolvedHarnessOrigin()
        : harnessSocket ||
          (await originOnFreePort("harness", resolvedHarnessOrigin()));
    const configuredHarnessPath =
        process.env.PIKVM_HARNESS_CONFIG || settings.get().harnessConfig;
    const harnessConfig = configuredHarnessPath
        ? isAbsolute(configuredHarnessPath)
            ? configuredHarnessPath
            : resolve(settings.dir(), configuredHarnessPath)
        : resolve(settings.dir(), "harness.yaml");
    if (!harnessRuntime.found) {
        /* No runtime, so no agent services — and the app says so instead of
         * spawning a name that does not exist and looking broken. Everything
         * that does not need Python carries on. */
        reportMissingAgentRuntime(harnessRuntime);
        return {
            control,
            settings,
            daemon: null,
            harness: null,
            harnessReady: Promise.resolve(),
        };
    }
    const harnessCommand = harnessRuntime.command;
    const harness = new HarnessManager({
        origin: harnessOrigin,
        daemonOrigin,
        command: harnessCommand,
        configPath: harnessConfig,
        runtimePath:
            process.env.PIKVM_HARNESS_RUNTIME ||
            resolve(settings.dir(), "harness-runtime.json"),
        managedClientRuntimePath: activeManagedClientRuntimePath(),
        cwd: settings.dir(),
        log: (line) => console.log(line),
    });

    startControlServer(
        {
            control,
            settings,
            /* Settings can change the PiKVM from the desktop app. The password goes to its own file and
             * is never returned; the control core follows the new target without a restart. */
            target: {
                view: () => targetStore.view(),
                save: (change) => {
                    control.setTarget(targetStore.save(change));
                    return targetStore.view();
                },
            },
            daemonOrigin,
            daemonToken: harness.daemonActionToken,
            /* So the conversation can be served from this origin and still reach
             * its own API. The operator capability is handed to the PROXY, never
             * to a renderer — same contract as the daemon token beside it. */
            harnessOrigin,
            harnessToken: harness.accessToken,
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
    console.log(`PiKVM backend listening on http://${bindHost}:${CONTROL_PORT} (UI proxy + /app/*; daemon ${daemonOrigin})`);

    const daemonRuntime = resolveDaemonRuntime(settings.get().daemonCmd);
    console.log(describeAgentRuntime(daemonRuntime));
    if (!daemonRuntime.found) {
        /* Reachable when PIKVM_AGENT_DAEMON_CMD or the daemonCmd setting names
         * something that is not there, since the harness resolved above without
         * consulting them. The harness is left running; only the daemon is out. */
        reportMissingAgentRuntime(daemonRuntime);
        return { control, settings, daemon: null, harness, harnessReady: Promise.resolve() };
    }
    const { command } = daemonRuntime;
    const args = ["daemon"];
    /* Tell the child WHERE, or the walk above is a lie.
     *
     * `pikvm-agent daemon` takes its host and port from its own config file, so
     * spawning it with a bare "daemon" while this side had moved to another port
     * left the two disagreeing: the app waited on 47617 while the child tried
     * 47615 over and over, hit the same orphan the walk existed to avoid, and
     * died five times before giving up. The origin is decided here, so it has to
     * be passed here. */
    const daemonEndpoint = parseEndpoint(daemonOrigin);
    const daemonArgs = [
        ...args,
        ...(daemonEndpoint.kind === "unix"
            ? ["--uds", daemonEndpoint.socketPath]
            : ["--host", daemonEndpoint.hostname, "--port", daemonEndpoint.port]),
    ];
    const daemon = new ManagedService({
        name: "daemon",
        origin: daemonOrigin,
        healthPath: "/healthz",
        command,
        args: daemonArgs,
        env: {
            PIKVM_AGENT_DAEMON_TOKEN: harness.daemonActionToken,
            PIKVM_AGENT_HARNESS_TOKEN: harness.daemonHarnessToken,
        },
        adoptExisting: false,
        log: (line) => console.log(line),
    });
    const harnessReady = daemon.start().then(async (outcome) => {
        if (outcome === "conflict") {
            throw new Error(
                `another credential-bound daemon already owns ${daemonOrigin}`,
            );
        }
        if (!(await daemon.waitUntilHealthy())) {
            daemon.stop();
            throw new Error(
                `machine-control daemon did not become healthy at ${daemonOrigin}`,
            );
        }
        await harness.start();
    });
    void harnessReady.catch((error) =>
            console.error(`[harness] startup failed: ${String(error)}`),
        );
    return {
        control,
        settings,
        daemon,
        harness,
        harnessReady,
    };
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

/** Set when startup found another copy of this app already on our usual port. */
let secondInstanceNotice: { wanted: number; using: number } | null = null;

async function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    // Not config.origin: that may still carry user:pass from an older install. The store reads both.
    const targetStore = new TargetStore(app.getPath("userData"));

    // The first-party chat harness is the desktop's sole workspace. Its isolated
    // session lets main inject the operator credential without ever exposing that
    // credential to page JavaScript.
    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));
    /* Resolved here rather than inside the proxy so a missing runtime is one
     * decision, not two: startProxyAndHarness() already reports it. */
    const harnessRuntime = resolveHarnessRuntime(settings.get().harnessCmd);

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

    win.on("closed", () => {
        backend?.harness?.stop();
        backend?.daemon?.stop();
    });

    // Start the local backend (PiKVM control core for the proxy, the agent harness and
    // the control server) — UNLESS we're a thin client pointing at a remote console,
    // where the remote host owns the proxy and the agent.
    const backend = remoteConsole
        ? null
        : await startProxyAndHarness(targetStore, settings, harnessRuntime);
    if (backend) {
        /* Nothing to load here any more: the conversation is rendered in the
         * console page, which waits for the harness itself and retries there.
         * Still worth reporting, because the console can only say "not yet"
         * while this knows the harness never started at all. */
        void backend.harnessReady.catch((error: unknown) => {
            const detail =
                error instanceof Error ? error.message : String(error ?? "unknown error");
            console.error(`[harness] never became ready: ${detail}`);
        });
    }

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
 * mean two control servers, two managed daemons and two harnesses fighting
 * over the same ports and the same runtime files. */
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

    app.whenReady().then(() => {
        console.log("Electron ready");
        app.commandLine.appendSwitch("ignore-certificate-errors");

        createWindow().catch((err) => reportFatal("starting the window", err));
    });
}
