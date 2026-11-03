/**
 * Headless web host: the same control server + PiKVM proxy + console the desktop
 * app runs, without Electron, for a container or any plain Node 22 host.
 *
 * What it serves is identical to the desktop's web surface (src/server/): the
 * console at `/app/` and the PiKVM UI proxied underneath it. There is no shell on
 * it, and no terminal anywhere: a shell on the server would turn "can see the KVM"
 * into "can run commands on the box that hosts it". The agent behind the Chat tab is the
 * chat server inside this process, which runs the omp binary.
 *
 * It has no login of its own. Sign-in belongs to the identity provider in
 * front of it (an OIDC proxy such as oauth2-proxy), and the deployment must
 * make that proxy the only route in. PIKVM_AUTH=proxy states that this is so;
 * without it the server only binds loopback.
 *
 * Configuration is environment-only, so a compose file and a machine `.env`
 * are the whole contract:
 *
 *   PIKVM_URL              PiKVM origin, e.g. https://pikvm.example.ts.net (required)
 *   PIKVM_USER             kvmd user (default "admin")
 *   PIKVM_PASSWORD         kvmd password (required)
 *   PIKVM_AUTH             "proxy": an authenticating reverse proxy is the only
 *                          way in, so bind any HOST. Unset: loopback only.
 *   PIKVM_KEYBOARD_LAYOUT  "us" | "uk" default before the Pi reports its keymap
 *   PIKVM_DATA_DIR         where settings.json and macros.json live (default ./data)
 *   PIKVM_JIGGLER          "1" makes the idle jiggler start on; only the first
 *                          value, after that the saved setting wins (default off)
 *   OMP_BIN                the agent program (omp) the Chat tab runs; the image sets it. Chat's data lives in
 *                          PIKVM_DATA_DIR/chat. Without omp conversations cannot be answered and Chat says so.
 *   HOST / PORT            bind address (default 0.0.0.0:8080 behind a proxy,
 *                          127.0.0.1:8080 otherwise)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createSharpImageOps } from "./image-ops-sharp";
import { resolve } from "node:path";
import { PiKvmControl } from "./pikvm-control";
import type { ImageOps } from "./image-ops";
import { startControlServer } from "./server";
import { SettingsStore, type AppSettings } from "./settings";

function env(name: string): string {
    return (process.env[name] ?? "").trim();
}

function fail(message: string): never {
    console.error(`[web] ${message}`);
    process.exit(1);
}

/** Settings the environment decides, whatever the data volume says.
 *
 *  SettingsStore persists the whole object on every patch. Overriding get() puts
 *  the env values into every read (the desktop's token gate reads accessToken
 *  per request, so a token left in an old settings.json can never switch it
 *  back on) while patch() still writes only the stored data. */
class EnvSettingsStore extends SettingsStore {
    constructor(
        path: string,
        private readonly overrides: Partial<AppSettings>,
    ) {
        super(path);
    }

    override get(): AppSettings {
        return { ...super.get(), ...this.overrides };
    }
}

/** The agent's screenshots are cropped and scaled by sharp, which the image installs beside dist/. A host
 *  that cannot load it stops here, saying so, rather than giving the agent frames its coordinates do not match. */
let images: ImageOps;
try {
    images = createSharpImageOps();
} catch (err) {
    fail(err instanceof Error ? err.message : String(err));
}

/** The chat migrations the build copied beside this file, when it is the bundle that runs. */
const bundledMigrations = resolve(__dirname, "chat-migrations");
const migrationsDir = existsSync(bundledMigrations) ? bundledMigrations : undefined;

const origin = env("PIKVM_URL");
if (!origin) fail("PIKVM_URL is required (for example https://pikvm.example.ts.net)");
let originUrl: URL;
try {
    originUrl = new URL(origin);
} catch {
    fail(`PIKVM_URL is not a URL: ${origin}`);
}
if (originUrl.username || originUrl.password) {
    fail("PIKVM_URL must not carry credentials; set PIKVM_USER and PIKVM_PASSWORD instead");
}
const password = env("PIKVM_PASSWORD");
if (!password) fail("PIKVM_PASSWORD is required");

const proxyAuth = env("PIKVM_AUTH") === "proxy";
if (env("PIKVM_AUTH") && !proxyAuth) fail(`PIKVM_AUTH must be "proxy" or unset, not ${env("PIKVM_AUTH")}`);

/* Nothing here asks who you are, so without a proxy vouching for every request
 * the server may only listen where nobody else can reach it. */
const host = env("HOST") || (proxyAuth ? "0.0.0.0" : "127.0.0.1");
if (!proxyAuth && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    fail(`HOST=${host} would expose the KVM with no sign-in; set PIKVM_AUTH=proxy behind an authenticating proxy`);
}
const port = Number(env("PORT") || 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`PORT is not a valid port: ${env("PORT")}`);

const dataDir = resolve(env("PIKVM_DATA_DIR") || "data");
mkdirSync(dataDir, { recursive: true });

/* The jiggler is off unless asked for. On the desktop it runs only while the app
 * is open; a server runs all day, so the same default would keep the target
 * awake around the clock whether or not anybody is using it.
 *
 * PIKVM_JIGGLER only seeds the FIRST value. SettingsStore writes its defaults
 * into the file on any patch, so "is there a jiggler key" cannot be asked after
 * the first patch; it is asked here, before anything has written. From then on
 * the stored value is the setting, so the Settings switch
 * (PATCH /app/api/v1/settings) actually takes effect. accessToken and bindHost
 * stay pinned to the environment. */
const settingsPath = resolve(dataDir, "settings.json");
let hasStoredJiggler = false;
try {
    hasStoredJiggler = typeof JSON.parse(readFileSync(settingsPath, "utf-8")).jiggler === "boolean";
} catch {
    /* no file yet, or unreadable: nothing stored */
}
const settings = new EnvSettingsStore(settingsPath, {
    // The desktop's token gate stays off: sign-in is the proxy's job here.
    accessToken: "",
    bindHost: host,
});
if (!hasStoredJiggler) settings.patch({ jiggler: env("PIKVM_JIGGLER") === "1" });

const layout = env("PIKVM_KEYBOARD_LAYOUT");
if (layout === "us" || layout === "uk") settings.patch({ keyboardLayout: layout });

const control = new PiKvmControl(
    {
        origin: originUrl.origin,
        username: env("PIKVM_USER") || "admin",
        password,
    },
);

const server = startControlServer(
    {
        control,
        settings,
        images,
        ...(migrationsDir ? { migrationsDir } : {}),
        ...(proxyAuth ? { refuseLoopback: true } : {}),
    },
    port,
    host,
    (err) => {
        fail(`server error on ${host}:${port}: ${err.message}`);
    },
);

server.on("listening", () => {
    console.log(`[web] console on http://${host}:${port}/ proxying ${originUrl.origin} (data ${dataDir})`);
});

function shutdown(signal: string): void {
    console.log(`[web] ${signal}, closing`);
    server.close(() => process.exit(0));
    // Open WebSockets (HID, stream) keep close() waiting; do not hang a container stop.
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
