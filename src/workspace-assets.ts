/**
 * Serves the conversation workspace from OUR origin.
 *
 * The same built bundle the harness serves at /app/, mounted here at
 * /_agent/workspace/ so the desktop can show it as part of the page instead of
 * loading it from another origin into a native view. Its API comes back through
 * /_agent/harness/*, which is same-origin from here, so nothing needs CORS and
 * the operator credential stays in the proxy.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";

/** The build output, which lives in this repo now (agent/ is a subtree).
 *
 *  Resolved from __dirname, which is dist/ at runtime. Injectable because that
 *  is only true when the app runs from its own tree: a test compiled into a
 *  temp directory, or a packaged build that puts the bundle elsewhere, has to
 *  be able to say where it actually is. */
export const defaultWorkspaceDir = resolve(__dirname, "..", "agent", "pikvm_agent", "harness_ui");

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
};

/** Where this host answers the harness API. Read by the bundle at load. */
export const WORKSPACE_API_BASE = "/_agent/harness";

/** The mount point. Assets resolve relative to it, so the trailing slash matters. */
export const WORKSPACE_PREFIX = "/_agent/workspace";

/**
 * Tells the bundle where its API is.
 *
 * A file rather than an inline script because the document ships a CSP with
 * `script-src 'self'` and no unsafe-inline — an injected inline tag would be
 * blocked, and the app would fall back to same-origin /api/*, which on this
 * server is the kvmd proxy. Wrong silently, which is the worst kind.
 */
const HOST_CONFIG =
    `window.__PIKVM_HARNESS_API_BASE__ = ${JSON.stringify(WORKSPACE_API_BASE)};\n` +
    /* And the sentinel that says "a host is managing authentication, do not ask
     * anyone to paste a token".
     *
     * It is not a secret and never was: the proxy attaches the real operator
     * credential server-side and discards whatever a page sent. But it lives in
     * sessionStorage, which is per BROWSING CONTEXT rather than per origin or
     * per session — so the native view being seeded did nothing for a frame in
     * the console, which came up asking for a token nobody has.
     *
     * Seeded here rather than by executing script into the context after load,
     * which is how the native views do it: this file already runs before the
     * app module for the API base, so the value is simply there when the app
     * first looks, with no reload to undo a prompt that already appeared. */
    `try { sessionStorage.setItem("pikvm-harness-token", "desktop-managed"); } catch (e) {}\n` +
    /* And the placement bridge the workspace header expects.
     *
     * As a native view it got this from a preload. A frame cannot have one, and
     * the app reads window.pikvmPanel while it mounts — so installing it from
     * the console on the frame's load event is already too late, and the header
     * simply drops the controls it cannot see. "Move to the left" and "Open in
     * its own window" disappeared with no error anywhere: the app degrades
     * gracefully, which is exactly what hid it.
     *
     * This file runs before the app module, so the bridge is there when it
     * looks. Same origin, so it is a plain postMessage to the console, which
     * owns the placement and the theme and already has the real IPC. */
    `(function () {
  var placement = [], theme = [];
  var post = function (type, value) {
    try { window.parent.postMessage({ channel: "pikvm-panel", type: type, value: value }, window.location.origin); } catch (e) {}
  };
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.channel !== "pikvm-panel") return;
    var list = d.type === "placement" ? placement : d.type === "theme" ? theme : null;
    if (list) list.slice().forEach(function (cb) { try { cb(d.value); } catch (err) {} });
  });
  var sub = function (list, cb) {
    list.push(cb);
    post("subscribe");
    return function () { var i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
  };
  /* Only when nothing better is already here.
   *
   * The detached conversation is a top-level WINDOW with a preload, so it gets
   * a real IPC bridge and has no parent to postMessage at. Assigning over that
   * would replace a working bridge with one that talks into the void — and the
   * buttons would still render, so it would fail silently. The embedded frame
   * has no preload, which is exactly when this one is needed. */
  if (!window.pikvmPanel) {
    window.pikvmPanel = {
      setSide: function (side) { post("set-side", side); },
      toggleDetached: function () { post("toggle-detached"); },
      onPlacement: function (cb) { return sub(placement, cb); },
      onTheme: function (cb) { return sub(theme, cb); }
    };
  }
})();\n`;
const HOST_CONFIG_FILE = "host-config.js";

/** Resolve a request path inside the build output, or null if it escapes. */
function workspaceFileIn(workspaceDir: string, relative: string): string | null {
    const file = relative.replace(/^\/+/, "");
    if (!file) return null;
    const p = resolve(workspaceDir, file);
    // A path that climbs out of the build directory is never served.
    if (p !== workspaceDir && !p.startsWith(workspaceDir + "/")) return null;
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return p;
}

/**
 * The document, with the host-config script inserted before the app module.
 *
 * Before, not after: the bundle reads the base once at module load, and a
 * module script runs after the document has parsed, so the ordering only has to
 * hold in source order.
 */
function indexHtmlIn(workspaceDir: string): string | null {
    const p = workspaceFileIn(workspaceDir, "index.html");
    if (!p) return null;
    const html = readFileSync(p, "utf8");
    const tag = `<script src="./${HOST_CONFIG_FILE}"></script>`;
    const at = html.indexOf("<script type=\"module\"");
    if (at < 0) return html.replace("</head>", `  ${tag}\n</head>`);
    return html.slice(0, at) + tag + "\n    " + html.slice(at);
}

export function createWorkspaceAssets(workspaceDir: string = defaultWorkspaceDir) {
    return {
        /** True when this path belongs to the workspace mount. */
        handles(path: string): boolean {
            return path === WORKSPACE_PREFIX || path.startsWith(WORKSPACE_PREFIX + "/");
        },

        /**
         * Serve it. Returns false only when the build output is missing, so the
         * caller can answer 404 rather than an empty 200.
         */
        serve(path: string, res: ServerResponse): boolean {
        // "./app.js" beside a document at /_agent/workspace resolves to
        // /_agent/app.js — the parent. Redirect so relative assets land.
        if (path === WORKSPACE_PREFIX) {
            res.writeHead(302, { location: WORKSPACE_PREFIX + "/" });
            res.end();
            return true;
        }
        const rest = path.slice(WORKSPACE_PREFIX.length + 1);

        if (rest === HOST_CONFIG_FILE) {
            res.writeHead(200, {
                "content-type": MIME[".js"],
                "cache-control": "no-store",
            });
            res.end(HOST_CONFIG);
            return true;
        }

        if (rest === "" || rest === "index.html") {
            const html = indexHtmlIn(workspaceDir);
            if (html === null) return false;
            res.writeHead(200, {
                "content-type": MIME[".html"],
                "cache-control": "no-cache",
            });
            res.end(html);
            return true;
        }

        const p = workspaceFileIn(workspaceDir, rest);
        if (!p) return false;
        const ext = rest.slice(rest.lastIndexOf("."));
        res.writeHead(200, {
            "content-type": MIME[ext] ?? "application/octet-stream",
            // Hashed asset names, except the two entry points above.
            "cache-control": "no-cache",
        });
        res.end(readFileSync(p));
        return true;
        },
    };
}

/** The instance the desktop server uses. */
export const workspaceAssets = createWorkspaceAssets();
