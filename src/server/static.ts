/**
 * Our own static bundle: the console, its scripts and styles, the PWA files
 * and the terminal renderer, all served from `dist/views` under `/app/`.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

/** Cookie the desktop shell sets on the proxy origin when it loads the Pi's own
 *  UI through us. Such a window must keep getting the Pi's page at `/`. */
export const DESKTOP_SHELL_COOKIE = "agent_shell";

// Built assets sit beside the compiled server in dist/views (CJS bundle, so
// __dirname is the dist root — matching how main.ts resolves its views).
export const defaultAssetDir = resolve(__dirname, "views");

const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** Resolve `file` inside `dir`, or null if it is missing or climbs out.
 *
 *  The containment check needs the trailing separator: a bare `startsWith(dir)`
 *  also accepts a sibling directory that merely begins with the same letters
 *  (`views-x` beside `views`). */
function assetIn(dir: string, file: string): string | null {
    const p = resolve(dir, file);
    if (!p.startsWith(dir + sep)) return null;
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return p;
}

export function createWebAssets(dir: string = defaultAssetDir) {
    return {
        /** Is there such a file in the bundle? */
        has(subPath: string): boolean {
            const file = subPath.replace(/^\/+/, "");
            return file !== "" && assetIn(dir, file) !== null;
        },

        /** Serve `<file>` from the bundle (a path relative to it, or with a
         *  leading slash); returns true if handled.
         *
         *  Files under `assets/` carry a content hash in their name (the web
         *  app's build), so they are cached for good; everything else is
         *  revalidated, because the console files and the app's index.html keep
         *  their names across releases. */
        serve(subPath: string, res: ServerResponse): boolean {
            const file = subPath.replace(/^\/+/, "");
            if (!file) return false;
            const p = assetIn(dir, file);
            if (!p) return false;
            const ext = file.slice(file.lastIndexOf("."));
            res.writeHead(200, {
                "content-type": MIME[ext] ?? "application/octet-stream",
                "cache-control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            });
            res.end(readFileSync(p));
            return true;
        },
    };
}

/** The web app's build output, beside the bundle in the repo and in the
 *  packages that copy it there (the same trick as the workspace bundle). */
export const defaultAppDir = resolve(__dirname, "..", "apps", "web", "dist");

/** The console bundle the server uses. */
export const webAssets = createWebAssets();

/** The web app, when it has been built (`yarn workspace @pikvm/web build`). */
export const appAssets = createWebAssets(defaultAppDir);
