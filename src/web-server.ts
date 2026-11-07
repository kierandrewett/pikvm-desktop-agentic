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
 * It signs users in itself, with no proxy or identity-aware gateway in front. Three methods, switched on by their
 * environment variables, any combination (src/server/web-auth/):
 *
 *   access token   PIKVM_ACCESS_TOKEN. `Authorization: Bearer <token>` for a remote PiKVM Desktop or a script (judged
 *                  by the bearer rules alone: a wrong token is refused 401, a request carrying an `Origin` that is not
 *                  this host's own is refused, plain http from a non-loopback peer is refused unless
 *                  PIKVM_SYNC_ALLOW_HTTP=1), and the same token typed into the sign-in form.
 *   password       PIKVM_LOGIN_USER with PIKVM_LOGIN_PASSWORD_HASH (scrypt, made by `node dist/web-server.js
 *                  --hash-password`) or PIKVM_LOGIN_PASSWORD. The sign-in form, and `Authorization: Basic` for scripts.
 *   OIDC           PIKVM_OIDC_ISSUER, PIKVM_OIDC_CLIENT_ID, PIKVM_PUBLIC_URL (and usually PIKVM_OIDC_CLIENT_SECRET and
 *                  an allow list). This host is the relying party of any OpenID Connect provider (Pocket ID, Keycloak,
 *                  Authentik ...); its redirect URI is <PIKVM_PUBLIC_URL>/app/auth/callback.
 *
 * The form methods and OIDC end in a signed session cookie. A bearer is never made into a cookie, a cookie is never
 * taken as a bearer, and Basic is judged by the password rules only. There is no loopback exemption once a method is
 * configured. The password, a typed token and Basic are refused over plain http from any peer but this machine.
 * With NO method configured the host binds loopback only and refuses any other HOST.
 *
 * Configuration is environment-only, so a compose file and a machine `.env`
 * are the whole contract:
 *
 *   PIKVM_URL              PiKVM origin, e.g. https://pikvm.example.ts.net (required)
 *   PIKVM_USER             kvmd user (default "admin")
 *   PIKVM_PASSWORD         kvmd password (required)
 *   PIKVM_ACCESS_TOKEN     the access token method (see above). Unset: no token, every bearer is refused.
 *   PIKVM_SYNC_ALLOW_HTTP  "1": accept a bearer over plain http from a non-loopback peer (default: refused)
 *   PIKVM_LOGIN_USER       the password method: the user name ...
 *   PIKVM_LOGIN_PASSWORD_HASH   ... and its `scrypt$N$r$p$salt$hash` line (N >= 16384) ...
 *   PIKVM_LOGIN_PASSWORD        ... or the plain password (a hash is better)
 *   PIKVM_OIDC_ISSUER      the OIDC method: the provider's issuer URL (https)
 *   PIKVM_OIDC_CLIENT_ID / PIKVM_OIDC_CLIENT_SECRET   the client; no secret = a public client (PKCE only)
 *   PIKVM_OIDC_SCOPES      default "openid email profile groups"
 *   PIKVM_OIDC_ALLOWED_GROUPS / _EMAILS / _SUBJECTS   comma lists; a user passes with any listed group in their `groups`
 *                          claim, a listed email the provider marks `email_verified: true`, or a listed `sub`. All three
 *                          empty: every user is refused.
 *   PIKVM_PUBLIC_URL       the origin users see, e.g. https://kvm.example.com (required for OIDC; https marks the
 *                          session cookie Secure and lets the password sign-in through)
 *   PIKVM_TRUST_PROXY      "1": believe X-Forwarded-Proto and X-Forwarded-For (the last hop) from a reverse proxy
 *                          that terminates TLS. Unset: those headers are ignored.
 *   PIKVM_SESSION_SECRET   at least 32 characters; default: a random secret kept in PIKVM_DATA_DIR/session-secret
 *   PIKVM_KEYBOARD_LAYOUT  "us" | "uk", saved target layout for typed text (default "us")
 *   PIKVM_DATA_DIR         where settings.json and macros.json live (default ./data)
 *   PIKVM_JIGGLER          "1" makes the idle jiggler start on; only the first
 *                          value, after that the saved setting wins (default off)
 *   OMP_BIN                the agent program (omp) the Chat tab runs; the image sets it. Chat's data lives in
 *                          PIKVM_DATA_DIR/chat. Without omp conversations cannot be answered and Chat says so.
 *   HOST / PORT            bind address (default 0.0.0.0:8080 with a sign-in method,
 *                          127.0.0.1:8080 without)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createSharpImageOps } from "./image-ops-sharp";
import { resolve } from "node:path";
import { PiKvmControl } from "./pikvm-control";
import type { ImageOps } from "./image-ops";
import { startControlServer } from "./server";
import type { WebAuth } from "./server/web-auth";
import { anyMethod, bindProblem, webAuthFromEnv } from "./server/web-auth/config";
import { hashPasswordCommand } from "./server/web-auth/password";
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

function main(): void {
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

    /* With no sign-in method the server may only listen where nobody else can reach it. */
    const signIn = anyMethod(env);
    const host = env("HOST") || (signIn ? "0.0.0.0" : "127.0.0.1");
    const unsafe = bindProblem(host, signIn);
    if (unsafe) fail(unsafe);
    const port = Number(env("PORT") || 8080);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`PORT is not a valid port: ${env("PORT")}`);

    const dataDir = resolve(env("PIKVM_DATA_DIR") || "data");
    mkdirSync(dataDir, { recursive: true });

    let webAuth: WebAuth | undefined;
    try {
        const setup = webAuthFromEnv(env, dataDir);
        webAuth = setup.auth;
        for (const warning of setup.warnings) console.warn(`[web] ${warning}`);
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    /** The agent's screenshots are cropped and scaled by sharp, which the image installs beside dist/. A host
     *  that cannot load it stops here, saying so, rather than giving the agent frames its coordinates do not match.
     *  After the configuration checks above, so a wrong setting is reported as that and not as a missing library. */
    let images: ImageOps;
    try {
        images = createSharpImageOps();
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

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
        // The desktop's token gate stays off: the web host signs in through src/server/web-auth.
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
            ...(webAuth ? { webAuth } : {}),
        },
        port,
        host,
        (err) => {
            fail(`server error on ${host}:${port}: ${err.message}`);
        },
    );

    server.on("listening", () => {
        const how = webAuth ? `sign-in: ${webAuth.methods.join(", ")}` : "no sign-in (loopback only)";
        console.log(`[web] console on http://${host}:${port}/ proxying ${originUrl.origin} (data ${dataDir}; ${how})`);
    });

    function shutdown(signal: string): void {
        console.log(`[web] ${signal}, closing`);
        server.close(() => process.exit(0));
        // Open WebSockets (HID, stream) keep close() waiting; do not hang a container stop.
        setTimeout(() => process.exit(0), 3000).unref();
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

/* `--hash-password` makes the hash line for PIKVM_LOGIN_PASSWORD_HASH and starts nothing else. */
if (process.argv.includes("--hash-password")) {
    void hashPasswordCommand().then((code) => process.exit(code));
} else {
    main();
}
