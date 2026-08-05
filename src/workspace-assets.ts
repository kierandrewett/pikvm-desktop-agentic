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
const HOST_CONFIG = `window.__PIKVM_HARNESS_API_BASE__ = ${JSON.stringify(WORKSPACE_API_BASE)};\n`;
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
