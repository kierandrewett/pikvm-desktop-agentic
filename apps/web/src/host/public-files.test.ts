/**
 * What makes the app installable: public/manifest.webmanifest, read from disk.
 *
 * Failure modes:
 *  P1. The manifest is not linked from the page, or its start URL / icons fall outside what the host serves.
 *
 * What the service worker (public/sw.js) does with requests, its cache and its updates is proved in a real browser
 * (apps/web/src/kvm/FAILURE_MODES.md K93 to K108), not by reading its source.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Paths, not URLs: the jsdom environment swaps in a URL class that fs does not accept.
const publicDir = resolve(import.meta.dirname, "../../public");
const read = (name: string): string => readFileSync(resolve(publicDir, name), "utf8");

describe("manifest", () => {
    const manifest = JSON.parse(read("manifest.webmanifest")) as {
        id: string;
        start_url: string;
        scope: string;
        display: string;
        icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    it("P1: is linked from the page, starts inside its own scope and is standalone", () => {
        expect(readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8")).toContain('rel="manifest" href="/app/manifest.webmanifest"');
        expect(manifest.display).toBe("standalone");
        expect(manifest.scope).toBe("/app/");
        expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
        expect(manifest.id).toBe("/app/");
    });

    it("P1: every icon is a file the app ships, with a 192 and a 512 and a maskable one", () => {
        for (const icon of manifest.icons) {
            expect(icon.src.startsWith("/app/")).toBe(true);
            expect(existsSync(resolve(publicDir, icon.src.slice("/app/".length))), icon.src).toBe(true);
        }
        expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
        expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
        expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    });
});
