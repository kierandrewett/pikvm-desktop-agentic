/**
 * Headless web host: the same control server + PiKVM proxy + console the desktop
 * app runs, without Electron, for a container or any plain Node 22 host.
 *
 * What it serves is identical to the desktop's web surface (src/server.ts): the
 * console at `/` and the PiKVM UI proxied underneath it. It deliberately does
 * NOT host the shared terminal or the agent harness. A shell on the server
 * would turn "can see the KVM" into "can run commands on the box that hosts
 * it", and the harness needs a desktop-owned runtime. The console reads
 * `features.terminal` from /_agent/api/state and hides the panel.
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
 *   PIKVM_JIGGLER          "1" keeps the target awake while idle (default off)
 *   PIKVM_DESKTOP_URL      the desktop app's console server, e.g.
 *                          http://fsociety.example.ts.net:25650. Set with
 *                          PIKVM_DESKTOP_TOKEN (its access token) to serve the
 *                          desktop's agent workspace as the Chat tab. The token
 *                          is attached here, server-side; browsers never see it.
 *   HOST / PORT            bind address (default 0.0.0.0:8080 behind a proxy,
 *                          127.0.0.1:8080 otherwise)
 */

import { mkdirSync } from "node:fs";
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

/** The web host never crops or resizes agent screenshots (there is no agent
 *  here), so the image hooks report "not done" and callers keep the original. */
const noImageOps: ImageOps = {
    resize: async () => null,
    crop: async () => null,
};

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
 * awake around the clock whether or not anybody is using it. */
const settings = new EnvSettingsStore(resolve(dataDir, "settings.json"), {
    // The desktop's token gate stays off: sign-in is the proxy's job here.
    accessToken: "",
    bindHost: host,
    jiggler: env("PIKVM_JIGGLER") === "1",
});

const layout = env("PIKVM_KEYBOARD_LAYOUT");
if (layout === "us" || layout === "uk") settings.patch({ keyboardLayout: layout });

const control = new PiKvmControl(
    {
        origin: originUrl.origin,
        username: env("PIKVM_USER") || "admin",
        password,
    },
    noImageOps,
);
control.setLayout(settings.get().keyboardLayout, { source: "auto" });

/* The Chat tab: the desktop's agent workspace, reached through the desktop's own
 * console server. That server already proxies /_agent/harness with the harness
 * operator capability attached, so this one forwards the path unchanged and
 * authenticates as a client of it. Both values come from the environment only;
 * no request can choose where this goes. */
const desktopUrl = env("PIKVM_DESKTOP_URL");
const desktopToken = env("PIKVM_DESKTOP_TOKEN");
if (!!desktopUrl !== !!desktopToken) fail("PIKVM_DESKTOP_URL and PIKVM_DESKTOP_TOKEN go together");
if (desktopUrl) {
    try {
        const u = new URL(desktopUrl);
        if (u.username || u.password || u.pathname !== "/" || u.search) throw new Error("origin only");
    } catch {
        fail(`PIKVM_DESKTOP_URL must be a bare origin like http://host:25650, not ${desktopUrl}`);
    }
}

const server = startControlServer(
    {
        control,
        settings,
        daemonToken: "",
        ...(desktopUrl ? { harnessOrigin: new URL(desktopUrl).origin, harnessToken: desktopToken, harnessPrefix: "" } : {}),
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
