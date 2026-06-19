/**
 * Single-token access gate for the server + proxy.
 *
 * When `settings.accessToken` is set, every request (proxied or `/_agent/*`) must
 * carry a valid session cookie, the token as `?token=`, or `Authorization: Bearer
 * <token>`. The session cookie value is derived from the token so it survives
 * restarts. PiKVM credentials stay server-side (the proxy injects them), so a
 * client only ever needs this one token - that is the auth simplification.
 *
 * Empty token = open (loopback dev, the default).
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SALT = "pikvm-agent.session.v1";
export const SESSION_COOKIE = "__agent_session";

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

/** Is this request allowed through? Always true when no token is configured. */
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
<link rel="manifest" href="/_agent/manifest.webmanifest">
<link rel="apple-touch-icon" href="/_agent/icon.png">
<link rel="icon" href="/_agent/icon.png">
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
</style></head>
<body>
  <form method="POST" action="/_agent/auth">
    <img class="logo" src="/_agent/icon.png" alt="" width="52" height="52">
    <h1>PiKVM Agent</h1>
    <p>Enter the access token to use this server.</p>
    <label for="t">Access token</label>
    <input id="t" name="token" type="password" autocomplete="current-password"
      autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" autofocus>
    <button type="submit">Sign in</button>
    ${error ? '<div class="note err">Wrong token. Try again.</div>' : ""}
    ${signedOut && !error ? '<div class="note ok">Signed out.</div>' : ""}
  </form>
</body></html>`;
}
