import {
    app,
    BrowserWindow,
    WebContentsView,
    ipcMain,
    shell,
    screen,
    dialog,
    nativeTheme,
    session,
    Menu,
} from "electron";
import {
    chmodSync,
    readFileSync,
    existsSync,
    mkdirSync,
    writeFileSync,
    statSync,
} from "fs";
import { createServer as createProbeServer } from "net";
import { get as httpGet } from "node:http";
import { resolve, isAbsolute, extname } from "path";
import {
    AGENT_EXECUTABLE,
    describeAgentRuntime,
    resolveAgentRuntime,
    type AgentRuntimeResolution,
} from "./agent-runtime";
import { parseEndpoint, unixEndpointValue } from "./endpoint";
import { PiKvmControl } from "./pikvm-control";
import { electronImageOps } from "./image-ops-electron";
import { startControlServer } from "./server";
import { SettingsStore } from "./settings";
import { TerminalSessions } from "./terminal-server";
import { ManagedService } from "./service-manager";
import { HarnessManager } from "./harness-manager";
import { activeManagedClientRuntimePath } from "./harness-runtime";
import { WORKSPACE_PREFIX } from "./server/workspace";
import { requestAttention } from "./taskbar-attention";
import { prepareGuiMcp, type GuiMcp } from "./gui-mcp";

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

// The unified web console (/app/) is the desktop UI: the main window loads it and
// the console draws its own titlebar/chrome (via the console preload's
// `window.desktopConsole`).
// Map a console RENDERER's webContents id → its window. The main window hosts the
// console in a child WebContentsView, so BrowserWindow.fromWebContents(sender) can
// return null; this resolves the window reliably for the console-scoped IPC.
const consoleWcToWin = new Map<number, Electron.BrowserWindow>();
// Window-chrome per platform: macOS keeps its native traffic lights (titleBarStyle
// "hidden", positioned to sit inside our 38px titlebar); Linux + Windows are fully
// frameless so the console draws its own controls (GTK-style on Linux).
const consoleFrameOpts: Electron.BrowserWindowConstructorOptions =
    process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 13, y: 10 } } : { frame: false };

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
            bundled: resolve(__dirname, "..", "agent", "runtime", "bin", AGENT_EXECUTABLE),
            workspace: resolve(__dirname, "..", "agent", ".venv", "bin", AGENT_EXECUTABLE),
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
            "The KVM view, terminal and console all work without it. Only the agent is unavailable.",
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

/** This run's ticket for the `pikvm` MCP server (src/gui-mcp.ts). */
let guiMcp: GuiMcp | null = null;

async function startProxyAndHarness(
    origin: string,
    settings: SettingsStore,
    harnessRuntime: AgentRuntimeResolution,
) {
    const control = new PiKvmControl(
        {
            origin,
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

    // Keep the optional browser/mobile shell service available for compatibility.
    // The desktop app does not create or render a terminal WebContentsView.
    const vaultPath = (): string => {
        const path = settings.get().atlas?.vaultPath;
        return path && path.trim() ? path : app.getPath("home");
    };
    const resolvePath = (path: string): string => {
        if (path.startsWith("~/")) return resolve(app.getPath("home"), path.slice(2));
        return isAbsolute(path) ? path : resolve(vaultPath(), path);
    };
    const imageMime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    };
    /* The `pikvm` MCP server (agent/docs/CUA.md) has tools only for a harness
     * started in these shells. A failure here costs that one feature, never
     * the terminal or the KVM. */
    try {
        guiMcp = prepareGuiMcp({
            directory: resolve(settings.dir(), "gui-mcp"),
            agentCommand: harnessRuntime.found ? harnessRuntime.command : null,
        });
        if (guiMcp.serverCommand) {
            console.log(`[gui-mcp] register this as the pikvm MCP server: ${guiMcp.serverCommand}`);
        }
    } catch (error) {
        console.error(`[gui-mcp] could not prepare the terminal MCP ticket: ${String(error)}`);
    }
    const terminalSessions = new TerminalSessions({
        vaultPath,
        prepareAgent: () => {},
        extraPath: () => guiMcp?.path ?? [],
        resolveImage: (path) => {
            try {
                const absolute = resolvePath(path);
                const mime = imageMime[extname(absolute).toLowerCase()];
                if (!mime || !existsSync(absolute)) return null;
                if (statSync(absolute).size > 12 * 1024 * 1024) return null;
                return `data:${mime};base64,${readFileSync(absolute).toString("base64")}`;
            } catch {
                return null;
            }
        },
        openPath: (path) => {
            const absolute = resolvePath(path);
            if (existsSync(absolute)) void shell.openPath(absolute);
        },
        openExternal: (url) => {
            if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        },
    });

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
            terminalSessions,
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
            terminalSessions,
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
        return { control, settings, terminalSessions, daemon: null, harness, harnessReady: Promise.resolve() };
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
        terminalSessions,
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

/** Resolve a console-chromed window from an IPC sender (the main window in console
 *  mode and any "open in new window" console both carry the console preload). */
function consoleWinFrom(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Electron.BrowserWindow | null {
    const w = consoleWcToWin.get(event.sender.id);
    return w && !w.isDestroyed() ? w : null;
}

// ── Console window IPC (only the frameless console carries preload-console) ──
ipcMain.on("console:minimise", (e) => consoleWinFrom(e)?.minimize());
ipcMain.on("console:toggle-maximise", (e) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on("console:close", (e) => consoleWinFrom(e)?.close());
// The console's background sampler saw the remote screen change meaningfully
// while this window was NOT focused → pulse its taskbar/dock entry. The renderer
// only sends this when it is unfocused; requestAttention re-checks anyway, since
// focus can land between the sample and the message arriving here.
ipcMain.on("console:screen-activity", (e) => {
    const w = consoleWinFrom(e);
    if (w) requestAttention(w);
});
ipcMain.handle("console:is-maximised", (e) => {
    const w = consoleWinFrom(e);
    return !!w && w.isMaximized();
});

// Snap the window so the live-screen area renders the native resolution 1:1. The
// renderer passes the stream's native size plus the window chrome around the
// screen's CONTENT box — the agent column, the titlebar, the divider — measured
// as one leftover rather than listed part by part, which is how the 1px divider
// used to be missed. We add it back and set the window's CONTENT size (excludes
// the OS frame — and we're frameless anyway).
ipcMain.on("console:fit-native", (e, opts: { width?: number; height?: number; chromeWidth?: number; chromeHeight?: number }) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    const nw = Number(opts?.width);
    const nh = Number(opts?.height);
    if (!nw || !nh || nw < 1 || nh < 1) return;
    const chromeW = Math.max(0, Math.round(Number(opts?.chromeWidth) || 0));
    const chromeH = Math.max(0, Math.round(Number(opts?.chromeHeight) || 0));
    if (w.isMaximized()) w.unmaximize();
    // That chrome is FIXED-pixel (it doesn't scale), so we scale only the SCREEN
    // to fit the work area beside it, then add it back. This makes the screen
    // column land exactly on the stream aspect — no black bars.
    const area = screen.getDisplayMatching(w.getBounds()).workAreaSize;
    const availW = Math.max(320, area.width - chromeW);
    const availH = Math.max(240, area.height - chromeH);
    const scale = Math.min(1, availW / nw, availH / nh);
    const screenW = Math.round(nw * scale);
    const screenH = Math.round(nh * scale);
    w.setContentSize(screenW + chromeW, screenH + chromeH);
});

// Build + pop a NATIVE menu from the renderer's spec; send the chosen id back.
ipcMain.on("console:popup-menu", (e, payload: { items?: any[]; anchor?: { x: number; y: number } }) => {
    const w = consoleWinFrom(e);
    if (!w) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const template: Electron.MenuItemConstructorOptions[] = items.map((it) => {
        if (it?.type === "separator") return { type: "separator" };
        return {
            label: String(it?.label ?? ""),
            type: it?.type === "checkbox" ? "checkbox" : "normal",
            checked: !!it?.checked,
            enabled: it?.enabled !== false,
            click: () => {
                // Send back to the SENDER renderer (the console view), not w.webContents
                // (empty for the main window which hosts the console in a child view).
                if (!e.sender.isDestroyed() && it?.id) e.sender.send("console:menu-command", String(it.id));
            },
        };
    });
    const menu = Menu.buildFromTemplate(template);
    const anchor = payload?.anchor;
    menu.popup(
        anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
            ? { window: w, x: Math.round(anchor.x), y: Math.round(anchor.y) }
            : { window: w }
    );
});

// ── Settings window ──────────────────────────────────────────────────────────
// The console's gear (and the native menu's "Settings") send console:open-settings.
// In the slim app there is no agent panel; open a small native Settings window with
// the only things a PiKVM client needs: connection URL, keyboard layout, jiggler.
const settingsFilePath = () => resolve(app.getPath("userData"), "agent-settings.json");
let settingsWin: Electron.BrowserWindow | null = null;
/** The console's current theme, so windows opened later match it.
 *
 *  The console owns the choice — it is a deliberate user setting kept in its own
 *  localStorage, not the OS preference — and it reports every change here. The
 *  Settings window is a separate BrowserWindow that cannot read that storage, so
 *  without remembering it here Settings opened black over a light console. */
let consoleTheme: "dark" | "light" = "dark";
/** Set when startup found another copy of this app already on our usual port. */
let secondInstanceNotice: { wanted: number; using: number } | null = null;
const THEME_BG = { dark: "#0a0a0c", light: "#eef0f4" } as const;

function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.focus();
        return;
    }
    settingsWin = new BrowserWindow({
        width: 460,
        height: 360,
        resizable: false,
        minimizable: false,
        maximizable: false,
        center: true,
        darkTheme: consoleTheme === "dark",
        title: "PiKVM Desktop — Settings",
        backgroundColor: THEME_BG[consoleTheme],
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-settings.js"),
        },
    });
    settingsWin.removeMenu();
    void settingsWin.loadFile(resolve(__dirname, "views", "settings-console.html"));
    // Grow the window to whatever the page actually needs before showing it.
    // width/height above include the window chrome, and how much that is
    // differs per platform — this GTK frame takes 80px, which left the page
    // 280px for 352px of content, so Settings opened already scrolled with
    // "Save & restart" below the fold in a window that cannot be resized.
    // useContentSize is not the fix: it is ignored here. Measuring the rendered
    // page is, and it also covers a larger system font or a longer hint.
    settingsWin.webContents.once("did-finish-load", () => {
        if (!settingsWin || settingsWin.isDestroyed()) return;
        void settingsWin.webContents
            .executeJavaScript("document.documentElement.scrollHeight")
            .then((needed: unknown) => {
                if (!settingsWin || settingsWin.isDestroyed()) return;
                const size = settingsWin.getContentSize();
                const width = size[0] ?? 0;
                const height = size[1] ?? 0;
                const wanted = Math.min(Math.ceil(Number(needed) || 0), 900);
                if (wanted > height) settingsWin.setContentSize(width, wanted);
            })
            .catch(() => {
                /* the fixed size still shows most of the form; never block the window */
            });
    });
    settingsWin.once("ready-to-show", () => settingsWin?.show());
    settingsWin.on("closed", () => {
        settingsWin = null;
    });
}

ipcMain.on("console:open-settings", () => openSettingsWindow());

// Read current settings for the form (origin lives in the desktop config; layout +
// jiggler in the SettingsStore file).
ipcMain.on("settings:read", (e) => {
    let pikvmUrl = "";
    let config: any = {};
    try {
        config = loadConfig();
        pikvmUrl = config.origin || "";
    } catch {
        /* no config yet */
    }
    const s = new SettingsStore(settingsFilePath()).get();
    e.returnValue = {
        pikvmUrl,
        keyboardLayout: s.keyboardLayout,
        jiggler: s.jiggler,
        /* Whether the PiKVM URL below is actually used.
         *
         * This was `envLocked: !!process.env.PIKVM_CONSOLE_ORIGIN`, and the
         * settings window never read it — it appears there once, as a key in
         * the fallback object, and nowhere else. It was also measuring the
         * wrong thing twice over: nothing in this app reads an env var for
         * `origin` (the setting this form edits), and a remote console can be
         * configured through `config.consoleOrigin` with no env var in sight.
         *
         * What it should mean is the condition CONSOLE_ORIGIN already decides
         * on: when the console is served from somewhere else, this desktop is a
         * thin client and the remote server owns the connection, the capture
         * and the HID. The local origin is then read by nothing, so offering an
         * editable field for it invites a change that relaunches the app and
         * has no effect. Computed the same way as CONSOLE_ORIGIN so the two
         * cannot disagree. */
        originLocked: !!(config.consoleOrigin || process.env.PIKVM_CONSOLE_ORIGIN),
    };
});

// Persist settings and relaunch so the new origin/layout apply cleanly (mirrors the
// existing console:set-pikvm-origin behaviour).
ipcMain.on("settings:save", (_e, v: { pikvmUrl?: unknown; keyboardLayout?: unknown; jiggler?: unknown }) => {
    const layout = v?.keyboardLayout === "uk" ? "uk" : "us";
    // Only touch the jiggler when the form actually sent a boolean. `!!v?.jiggler`
    // turned it OFF for any save that omitted the field — a silent way to lose the
    // keep-awake without anyone choosing to.
    const patch: { keyboardLayout: "us" | "uk"; jiggler?: boolean } = { keyboardLayout: layout };
    if (typeof v?.jiggler === "boolean") patch.jiggler = v.jiggler;
    new SettingsStore(settingsFilePath()).patch(patch);
    const cfg = loadConfig();
    const url = typeof v?.pikvmUrl === "string" ? v.pikvmUrl.trim().replace(/\/$/, "") : "";
    if (url) cfg.origin = url;
    saveConfig(cfg);
    app.relaunch();
    app.exit(0);
});

ipcMain.on("settings:cancel", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
// Read synchronously at load, so the window paints in the right theme on its
// first frame rather than flashing the wrong one.
ipcMain.on("settings:theme", (e) => {
    e.returnValue = consoleTheme;
});

/** Standard editing context menu (cut/copy/paste/select all) for a view. */
function attachContextMenu(wc: Electron.WebContents) {
    wc.on("context-menu", (_e, params) => {
        const f = params.editFlags;
        const template: Electron.MenuItemConstructorOptions[] = [];
        if (params.isEditable) {
            template.push(
                { role: "cut", enabled: f.canCut },
                { role: "copy", enabled: f.canCopy },
                { role: "paste", enabled: f.canPaste },
                { type: "separator" },
                { role: "selectAll" }
            );
        } else if (params.selectionText) {
            template.push({ role: "copy" }, { role: "selectAll" });
        }
        if (!template.length) return;
        Menu.buildFromTemplate(template).popup();
    });
}

async function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    let origin = config.origin;

    const consoleSize = { width: 1400, height: 880 };

    const win = new BrowserWindow({
        // The console is the full primary UI → open at a proper desktop size and let
        // it be resized.
        width: consoleSize.width,
        height: consoleSize.height,
        minWidth: 900,
        minHeight: 560,
        center: true,
        darkTheme: true,
        ...consoleFrameOpts,
        icon: appIconPath,
        title: "PiKVM Desktop",
        backgroundColor: "#0a0a0c",
        // Start hidden so the user never sees the white "flashbang" before the
        // console paints; we reveal it once the content has loaded (below).
        show: false,
    });

    const mainView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            // The main view IS the unified console, so it carries the console
            // preload (window.desktopConsole → its own titlebar, native menus,
            // fit-native).
            preload: resolve(__dirname, "preload-console.js"),
            // The console runs capture timers; don't let Chromium throttle them
            // when the window is unfocused.
            backgroundThrottling: false,
        },
    });
    // Dark view background so there is no white paint before the console CSS applies.
    mainView.setBackgroundColor("#0a0a0c");

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
    mainView.webContents.on("did-finish-load", () => {
        // Only a load that did NOT fail clears the ceilings. An error page
        // finishing is not the console loading.
        if (!loadFailedThisAttempt) {
            consoleLoadFails = 0;
            localLoadFails = 0;
        }
        setTimeout(revealWindow, 60);
    });
    setTimeout(revealWindow, 4000); // fallback in case load never finishes

    // The first-party chat harness is the desktop's sole workspace. Its isolated
    // session lets main inject the operator credential without ever exposing that
    // credential to page JavaScript.
    const settings = new SettingsStore(resolve(app.getPath("userData"), "agent-settings.json"));
    /* Resolved here rather than inside the proxy so a missing runtime is one
     * decision, not two: startProxyAndHarness() already reports it. */
    const harnessRuntime = resolveHarnessRuntime(settings.get().harnessCmd);

    // Opt-in: load the KVM view through our own proxy instead of the Pi directly,
    // so the desktop shares the web client's rendering path. Off by default; needs
    // a restart to change. `viewOrigin()` is a live function so a runtime origin
    // change still applies in the default (non-proxy) mode.
    /* Settle the port FIRST. Everything below is built from it, and until this
     * moved here the window built its origin from the port we hoped for rather
     * than the one we got. */
    await settleControlPort(process.env.PIKVM_BIND_HOST || settings.get().bindHost || "127.0.0.1");
    const PROXY_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
    const desktopProxy = settings.get().desktopUseProxy;
    // The console can be served from ANYWHERE — set it in Settings → Connection (or
    // the PIKVM_CONSOLE_ORIGIN env override) to point the desktop at a hosted
    // deployment. When it's not the local server, the desktop is a pure THIN CLIENT:
    // it loads the remote console and does NOT start a local backend (the remote
    // server owns the agent, capture, HID, proxy, etc.).
    const CONSOLE_ORIGIN = (config.consoleOrigin || process.env.PIKVM_CONSOLE_ORIGIN || PROXY_ORIGIN).replace(/\/$/, "");
    const remoteConsole = CONSOLE_ORIGIN !== PROXY_ORIGIN;
    const viewOrigin = () => (desktopProxy ? PROXY_ORIGIN : origin);
    const CONSOLE_URL = `${CONSOLE_ORIGIN}/app/`;
    if (desktopProxy) {
        // Mark this Electron session as the desktop shell so the proxy hands the
        // Pi's own page at `/` to it instead of redirecting to the console.
        void session.defaultSession.cookies
            .set({ url: PROXY_ORIGIN, name: "agent_shell", value: "desktop", expirationDate: Date.now() / 1000 + 31536000 })
            .catch(() => {});
    }

    // The main window is console-chromed: it carries the console preload, so
    // register it for the console-scoped IPC (window controls, fit-native, native
    // menus) and mirror its maximise state to the titlebar glyph.
    // The console renderer is mainView (a child view), so register ITS webContents
    // and send window-state to it (not win.webContents, which is empty).
    const consoleWcId = mainView.webContents.id;
    consoleWcToWin.set(consoleWcId, win);
    const mirrorMax = () => {
        if (!win.isDestroyed()) mainView.webContents.send("console:maximise-change", win.isMaximized());
    };
    win.on("maximize", mirrorMax);
    win.on("unmaximize", mirrorMax);
    win.on("closed", () => consoleWcToWin.delete(consoleWcId));

    win.contentView.addChildView(mainView);

    const layout = () => {
        const [w, h] = win.getContentSize();
        console.log(`Layout: ${w}x${h}`);

        // The console draws its OWN titlebar, so the main view fills the whole window.
        mainView.setBounds({ x: 0, y: 0, width: w!, height: h! });
    };

    ipcMain.on("console:agent-theme", (_, theme: unknown) => {
        if (theme !== "dark" && theme !== "light") return;
        consoleTheme = theme;
        // Settings is a plain window rather than part of the conversation, but it
        // is still this app's window and should not be the one thing left dark.
        if (settingsWin && !settingsWin.isDestroyed()) {
            settingsWin.setBackgroundColor(THEME_BG[theme]);
            settingsWin.webContents.send("settings:theme", theme);
        }
    });
    win.on("closed", () => {
        backend?.terminalSessions.killAll();
        guiMcp?.dispose();
        backend?.harness?.stop();
        backend?.daemon?.stop();
    });

    // Right-click editing menus on the main view.
    attachContextMenu(mainView.webContents);

    // Start the local backend (PiKVM control core for the proxy + the shared
    // terminal + the control server) — UNLESS we're a thin client pointing at a
    // remote console, where the remote host owns the proxy + terminal.
    const backend = remoteConsole
        ? null
        : await startProxyAndHarness(origin, settings, harnessRuntime);
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


    win.on("resize", layout);
    layout();

    const wc = mainView.webContents;

    const connect = () => {
        // The unified console is the desktop UI; it proxies to the Pi itself and
        // draws its OWN titlebar (window controls + audio/mic + fit-native), so it
        // fills the whole window.
        console.log("Loading unified console at:", CONSOLE_URL);
        loadFailedThisAttempt = false;
        mainView.webContents.loadURL(CONSOLE_URL);
    };

    wc.setWindowOpenHandler(({ url }) => {
        console.log("Window open request:", url);

        const parsedOrigin = new URL(viewOrigin());
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("Opening externally");
            shell.openExternal(url);
            return { action: "deny" };
        }

        console.log("Allowed internally");
        return { action: "allow" };
    });

    wc.on("before-input-event", (_, input) => {
        if ((input.control || input.meta) && input.key.toLowerCase() === "w") {
            console.log("Blocked Ctrl/Cmd+W");
            return false;
        }
    });

    wc.on("will-navigate", (e, url) => {
        console.log("Will navigate:", url);

        const parsedOrigin = new URL(viewOrigin());
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("External navigation blocked");
            e.preventDefault();
            shell.openExternal(url);
        }
    });

    wc.on("did-navigate", (_, url) => {
        console.log("Navigated:", url);
        // Match the input-forwarding guard to the current focus state on load.
        mainView.webContents.send("kvm:input-enabled", win.isFocused());
    });

    win.on("focus", () => {
        // Re-enable forwarding input to the remote now that we're focused.
        mainView.webContents.send("kvm:input-enabled", true);
    });
    win.on("blur", () => {
        // Stop any mouse/keyboard from reaching the KVM while we're not focused.
        mainView.webContents.send("kvm:input-enabled", false);
    });

    mainView.webContents.addListener("zoom-changed", () => {
        mainView.webContents.setVisualZoomLevelLimits(1, 1);
        mainView.webContents.setZoomLevel(1);
    });

    mainView.webContents.on("will-prevent-unload", (e) => {
        console.log("Unload prevented");
        e.preventDefault();
    });

    // The main view IS the unified console from boot.
    connect();

    mainView.webContents.addListener(
        "did-fail-load",
        (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
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
                    detail: (errorDescription || "The server may be down or the address may be wrong.") + "\n\nUse the local server to get back in and fix the address in Settings → Connection.",
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
        },
    );

    const allowedPermissions = new Set([
        "media",
        "clipboard-read",
        "clipboard-sanitized-write",
        "clipboard-write",
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

    /* Tell the console whether a download actually landed.
     *
     * Save screenshot builds a blob, calls click() on an <a download>, and
     * toasts "Screenshot saved" on the next line. click() only HANDS the file
     * to the download machinery: in the desktop app that can open a save
     * dialog the user cancels, or fail on a full or read-only disk, and the
     * console said it had saved either way. It is the one place in this app
     * that reports an outcome it never observed.
     *
     * The renderer keeps its own fallback for the web build, where there is no
     * main process and no event like this to wait for. */
    session.defaultSession.on("will-download", (_event, item, webContents) => {
        item.once("done", (_doneEvent, state) => {
            if (webContents.isDestroyed()) return;
            webContents.send("console:download-done", {
                name: item.getFilename(),
                state,
                path: state === "completed" ? item.getSavePath() : "",
            });
        });
    });

    if (
        process.env.NODE_ENV === "development" ||
        process.env.DEVTOOLS === "1"
    ) {
        mainView.webContents.openDevTools({ mode: "detach" });
    }

    mainView.webContents.focus();
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
    app.on("second-instance", () => {
        const [win] = BrowserWindow.getAllWindows();
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });

    app.whenReady().then(() => {
        console.log("Electron ready");
        app.commandLine.appendSwitch("ignore-certificate-errors");

        createWindow().catch((err) => reportFatal("starting the window", err));
    });
}
