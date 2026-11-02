/**
 * Headless web host: the same control server + PiKVM proxy + console the desktop
 * app runs, without Electron, for a container or any plain Node 22 host.
 *
 * What it serves is identical to the desktop's web surface (src/server.ts): the
 * console at `/`, the PiKVM UI proxied underneath it, the single-token login. It
 * deliberately does NOT host the shared terminal or the agent harness. A shell
 * on the server would turn "can see the KVM" into "can run commands on the box
 * that hosts it", and the harness needs a desktop-owned runtime. The console
 * reads `features.terminal` from /_agent/api/state and hides the panel.
 *
 * Configuration is environment-only, so a compose file and a machine `.env`
 * are the whole contract:
 *
 *   PIKVM_URL              PiKVM origin, e.g. https://pikvm.example.ts.net (required)
 *   PIKVM_USER             kvmd user (default "admin")
 *   PIKVM_PASSWORD         kvmd password (required)
 *   PIKVM_ACCESS_TOKEN     token for the web login gate (required, unless
 *                          PIKVM_ALLOW_OPEN=1 for a loopback-only dev run)
 *   PIKVM_KEYBOARD_LAYOUT  "us" | "uk" default before the Pi reports its keymap
 *   PIKVM_DATA_DIR         where settings.json and macros.json live (default ./data)
 *   PIKVM_JIGGLER          "1" keeps the target awake while idle (default off)
 *   HOST / PORT            bind address (default 0.0.0.0:8080)
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

/** Settings whose secrets come from the environment and are never written to disk.
 *
 *  SettingsStore persists the whole object on every patch. Overriding get() puts
 *  the env values into every read (the auth gate reads accessToken per request)
 *  while patch() still writes only the stored data, so the token never lands in
 *  the data volume. */
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

const accessToken = env("PIKVM_ACCESS_TOKEN");
const allowOpen = env("PIKVM_ALLOW_OPEN") === "1";
if (!accessToken && !allowOpen) {
    fail("PIKVM_ACCESS_TOKEN is required (PIKVM_ALLOW_OPEN=1 runs without a login gate, for local development only)");
}

/* Open mode drops the login gate, so it may only listen where nobody else can
 * reach it. Default to loopback there and refuse anything wider. */
const host = env("HOST") || (accessToken ? "0.0.0.0" : "127.0.0.1");
if (!accessToken && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    fail(`PIKVM_ALLOW_OPEN=1 without PIKVM_ACCESS_TOKEN only binds loopback; HOST=${host} would expose the KVM unauthenticated`);
}
const port = Number(env("PORT") || 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`PORT is not a valid port: ${env("PORT")}`);

const dataDir = resolve(env("PIKVM_DATA_DIR") || "data");
mkdirSync(dataDir, { recursive: true });

/* The jiggler is off unless asked for. On the desktop it runs only while the app
 * is open; a server runs all day, so the same default would keep the target
 * awake around the clock whether or not anybody is using it. */
const settings = new EnvSettingsStore(resolve(dataDir, "settings.json"), {
    accessToken,
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

const server = startControlServer({ control, settings, daemonToken: "" }, port, host, (err) => {
    fail(`server error on ${host}:${port}: ${err.message}`);
});

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
