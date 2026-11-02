/**
 * The one access gate for the server, its proxies and its WebSocket upgrades.
 *
 * When `settings.accessToken` is set, every request (proxied or under `/app`)
 * must carry a valid session cookie, the token as `?token=`, or
 * `Authorization: Bearer <token>`. The session cookie value is derived from the
 * token so it survives restarts. PiKVM credentials stay server-side (the proxy
 * injects them), so a client only ever needs this one token.
 *
 * Empty token = open (loopback dev, the default). routes.ts asks `gate()` once
 * per request and once per upgrade; nothing else in the server checks a token.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SALT = "pikvm-agent.session.v1";
export const SESSION_COOKIE = "__agent_session";

/** Marks a request as coming from our own workspace bundle or console. Its
 *  only job is to be un-settable by a cross-origin request without a preflight,
 *  and this server answers preflights for nobody. Required by the routes that
 *  carry a server-held capability (the harness and the daemon proxies). */
export const WORKSPACE_HEADER = "x-pikvm-workspace";

/** Paths that never need a session, token or not.
 *
 *  The sign-in endpoints must be reachable to sign in. The PWA files are public
 *  because the sign-in page itself links its icon and manifest, and a browser
 *  fetches the manifest and the service worker without credentials: behind the
 *  gate they answered 401, so the installed app had no icon until it was already
 *  signed in. None of them carries anything private (icons, a manifest, a
 *  script that only caches). An authenticating reverse proxy in front must skip
 *  the same list; the README names it. */
export const PUBLIC_PATHS: Readonly<Record<string, true>> = {
    "/app/login": true,
    "/app/auth": true,
    "/app/logout": true,
    "/app/manifest.webmanifest": true,
    "/app/sw.js": true,
    // The retire worker for installs made before the move to /app (legacy-prefix.ts).
    "/_agent/sw.js": true,
    "/app/icon.png": true,
    "/app/icon-192.png": true,
    "/app/icon-512.png": true,
    "/app/apple-touch-icon.png": true,
};

/** Stable cookie value for a token (so sessions persist across restarts). */
export function sessionValue(token: string): string {
    return createHash("sha256").update(`${SALT}:${token}`).digest("hex");
}

/** Loopback clients (the desktop app itself) are trusted and skip the gate. */
export function isLoopback(req: IncomingMessage): boolean {
    const a = req.socket.remoteAddress ?? "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

/** Does this request carry the token, in a cookie, `?token=` or a bearer header? */
export function isAuthed(req: IncomingMessage, token: string): boolean {
    if (!token) return true;
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE] === sessionValue(token)) return true;
    try {
        const u = new URL(req.url ?? "/", "http://x");
        if (u.searchParams.get("token") === token) return true;
    } catch {
        /* malformed url */
    }
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth === `Bearer ${token}`) return true;
    return false;
}

/** Compare a submitted token with the real one without leaking, through timing,
 *  how much of it was right. Hashing first gives both sides equal length. */
export function tokenMatches(submitted: string, token: string): boolean {
    const a = createHash("sha256").update(submitted).digest();
    const b = createHash("sha256").update(token).digest();
    return token !== "" && timingSafeEqual(a, b);
}

/** What the gate decides about one request. */
export type GateVerdict =
    /** Carry on to the route. */
    | "allow"
    /** Not signed in, and the client asked for a page: send it to the sign-in page. */
    | "login"
    /** Not signed in: refuse (401 for HTTP, the socket is destroyed for an upgrade). */
    | "deny";

/** The gate. `path` is the request's pathname, already parsed by the caller.
 *
 *  Loopback is exempt because the desktop app talks to itself over it. That is
 *  only safe against processes on the machine: the gate cannot tell a browser
 *  page POSTing to 127.0.0.1 from the app, which is why the routes that attach
 *  a capability also demand WORKSPACE_HEADER. It also means a reverse proxy on
 *  the same host defeats the gate; the web host therefore refuses a non-loopback
 *  bind unless an authenticating proxy is declared (src/web-server.ts). */
export function gate(req: IncomingMessage, path: string, token: string): GateVerdict {
    if (!token || Object.hasOwn(PUBLIC_PATHS, path) || isLoopback(req) || isAuthed(req, token)) return "allow";
    return String(req.headers.accept ?? "").includes("text/html") ? "login" : "deny";
}

/** Does the request carry the header that proves it came from our own pages? */
export function hasWorkspaceHeader(req: IncomingMessage): boolean {
    return req.headers[WORKSPACE_HEADER] === "1";
}

/**
 * Dark, mobile-first login page. Part of the installable PWA shell (theme +
 * apple-* meta + manifest), so a phone that launches the app to a logged-out
 * state still gets the themed, standalone, safe-area-aware screen. `error` shows
 * a wrong-token notice; `signedOut` confirms a logout.
 */
export function loginPage(error = false, signedOut = false): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="PiKVM">
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app/icon.png">
<link rel="icon" href="/app/icon.png">
<title>PiKVM Agent - sign in</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
    background:#0b0d12;color:#e7e9ee;font-family:-apple-system,system-ui,"Segoe UI",sans-serif}
  form{width:min(360px,100%);padding:28px;border:1px solid #232838;border-radius:16px;background:#11141c}
  .logo{display:block;width:52px;height:52px;margin:0 auto 14px;border-radius:13px}
  h1{margin:0 0 4px;font-size:18px;text-align:center}
  p{margin:0 0 18px;font-size:13px;color:#8b90a0;text-align:center}
  label{display:block;font-size:12px;color:#8b90a0;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #2a3042;background:#0b0d12;
    color:#e7e9ee;font-size:16px;outline:none}
  input:focus{border-color:#3b6ef0}
  button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#3b6ef0;
    color:#fff;font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .note{margin-top:12px;font-size:13px;text-align:center}
  .err{color:#f97583}
  .ok{color:#56d364}
  /* The error sits between the field and the button, so the button's own
     margin would double up with the note's. Keep the rhythm the page had. */
  .err+button{margin-top:12px}
  /* Say which field is wrong in more than words: the token input is the only
     thing on the page, and a red sentence near it is worth nothing to anyone
     who cannot see the colour or the proximity. */
  input[aria-invalid="true"]{border-color:#f97583}
  input[aria-invalid="true"]:focus{border-color:#f97583}
</style></head>
<body>
  <form method="POST" action="/app/auth">
    <img class="logo" src="/app/icon.png" alt="" width="52" height="52">
    <h1>PiKVM Agent</h1>
    <p>Enter the access token to use this server.</p>
    <label for="t">Access token</label>
    <input id="t" name="token" type="password" autocomplete="current-password"
      autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" autofocus
      ${error ? 'aria-invalid="true" aria-describedby="signin-error"' : ""}>
    ${error ? '<div class="note err" id="signin-error" role="alert">Wrong token. Try again.</div>' : ""}
    <button type="submit">Sign in</button>
    ${signedOut && !error ? '<div class="note ok" role="status">Signed out.</div>' : ""}
  </form>
</body></html>`;
}
