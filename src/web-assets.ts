/**
 * Web assets bolted onto the proxied PiKVM pages.
 *
 * `htmlInjection()` returns the markup spliced into proxied HTML before </head>.
 * `serve()` serves our own bundle under `/_agent/...`. Phase 1 only injects a
 * mobile viewport; Phase 2 adds the agent UI bundle + mount container.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";

// Built assets sit beside the compiled server in dist/views (CJS bundle, so
// __dirname is the dist root — matching how main.ts resolves its views).
const assetDir = resolve(__dirname, "views");

const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
};

function asset(file: string): string | null {
    const p = resolve(assetDir, file);
    // Stay inside the asset dir.
    if (!p.startsWith(assetDir)) return null;
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return p;
}

export const webAssets = {
    /** Markup injected into proxied HTML (mobile viewport for now). */
    htmlInjection(): string {
        return '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" data-pikvm-agent>';
    },

    /** Serve `/_agent/<file>`; returns true if handled. */
    serve(subPath: string, res: ServerResponse): boolean {
        const file = subPath.replace(/^\/+/, "");
        if (!file) return false;
        const p = asset(file);
        if (!p) return false;
        const ext = file.slice(file.lastIndexOf("."));
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(readFileSync(p));
        return true;
    },
};
