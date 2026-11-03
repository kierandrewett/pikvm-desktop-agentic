/**
 * What the production build ships for the installed phone app, audited on the build's own output (CSS, index.html,
 * the generated launch images), not on the sources: Tailwind generates rules nobody wrote by hand, and a plugin
 * writes files nobody checked in.
 *
 * Failure modes:
 *  N1. A :hover rule outside `@media (hover: hover) and (pointer: fine)` ships: on a phone a tap leaves it stuck on.
 *  N2. A tappable control has no pressed state, or the pressed state waits on a transition.
 *  N3. A text size that is not a type token ships in the app's own CSS (so Dynamic Type skips it), or a token is used
 *      that is not defined for iOS.
 *  N4. A launch-image link points at a file the build did not write, has the wrong size for its media query, or the
 *      page has no link for a current iPhone.
 *  N5. The one rule that keeps iOS from zooming into a field is gone.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import postcss, { type AtRule, type Container, type Document, type Root, type Rule } from "postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePng, SCREENS, SPLASH_BACKGROUND, startupImages } from "../../startup-images";

const webRoot = resolve(import.meta.dirname, "../..");

interface Built {
    css: Array<{ name: string; root: Root }>;
    files: Map<string, Uint8Array | string>;
    html: string;
}

let built: Built;
let outDir = "";

function listFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

beforeAll(() => {
    // A real `vite build` in a child process, into a scratch directory: the same command that ships the app. (The
    // jsdom this file runs in swaps URL for its own class, which Vite's Node API does not accept.)
    outDir = mkdtempSync(join(tmpdir(), "pikvm-web-build-"));
    const vite = join(resolve(createRequire(import.meta.url).resolve("vite/package.json"), ".."), "bin/vite.js");
    execFileSync(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir", "--sourcemap", "false", "--logLevel", "error"], {
        cwd: webRoot,
        env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
        stdio: ["ignore", "pipe", "inherit"],
    });
    const files = new Map<string, Uint8Array | string>();
    for (const path of listFiles(outDir)) files.set(relative(outDir, path), readFileSync(path));
    const css = [...files]
        .filter(([name]) => name.endsWith(".css"))
        .map(([name, source]) => ({ name, root: postcss.parse(String(source)) }));
    built = { css, files, html: String(files.get("index.html")) };
}, 240_000);

afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const HOVER_MEDIA = /^\(hover:\s*hover\)\s+and\s+\(pointer:\s*fine\)$/;

function guardedByHoverMedia(rule: Rule): boolean {
    for (let at: Container | Document | undefined = rule.parent; at && at.type !== "root"; at = at.parent) {
        if (at.type === "atrule" && (at as AtRule).name === "media" && HOVER_MEDIA.test((at as AtRule).params.trim())) return true;
    }
    return false;
}

describe("N1: :hover only on a device with a real pointer", () => {
    it("every built rule that mentions :hover sits inside @media (hover: hover) and (pointer: fine)", () => {
        const loose: string[] = [];
        let guarded = 0;
        for (const { name, root } of built.css) {
            root.walkRules((rule) => {
                if (!rule.selector.includes(":hover")) return;
                if (guardedByHoverMedia(rule)) guarded++;
                else loose.push(`${name}: ${rule.selector.slice(0, 120)}`);
            });
        }
        expect(loose).toEqual([]);
        // The audit saw the rules (Tailwind's hover: and group-hover: variants, and the hand-written ones).
        expect(guarded).toBeGreaterThan(40);
    });

    it("the Tailwind hover: variant of both style sheets is the same media query", () => {
        const loose: string[] = [];
        for (const { name, root } of built.css) {
            root.walkAtRules("media", (rule) => {
                if (/hover:\s*hover/.test(rule.params) && !/pointer:\s*fine/.test(rule.params)) loose.push(`${name}: @media ${rule.params}`);
            });
        }
        expect(loose).toEqual([]);
    });
});

describe("N2: pressed", () => {
    it("a pressed button, link, tab or row dims at once: the shipped :active rule has no transition", () => {
        let found: Rule | undefined;
        for (const { root } of built.css) {
            root.walkRules((rule) => {
                if (rule.selector.includes(":active") && rule.selector.includes("button") && /\[role=["']?tab["']?\]/.test(rule.selector)) found = rule;
            });
        }
        expect(found, "the generic :active rule").toBeDefined();
        const declarations = new Map<string, string>();
        found!.walkDecls((d) => void declarations.set(d.prop, d.value));
        expect(Number(declarations.get("opacity"))).toBeLessThan(1);
        expect(declarations.get("transition-duration")).toMatch(/^0(s|ms)?$/);
        // Not on a disabled control.
        expect(found!.selector).toContain(":disabled");
    });

    it("the document has the touch basics: no tap highlight, manipulation on controls, no root overscroll", () => {
        const all = built.css.map(({ root }) => root.toString()).join("\n");
        expect(all).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
        expect(all).toMatch(/overscroll-behavior:\s*none/);
        expect(all).toMatch(/-webkit-touch-callout:\s*none/);
        let controls: Rule | undefined;
        for (const { root } of built.css) {
            root.walkRules((rule) => {
                if (rule.selector.includes("button") && rule.selector.includes("input") && /touch-action:\s*manipulation/.test(rule.toString())) controls = rule;
            });
        }
        expect(controls, "touch-action: manipulation on the controls").toBeDefined();
    });
});

describe("N3: text sizes are tokens", () => {
    const appCss = (): Array<{ name: string; root: Root }> => built.css.filter(({ name }) => !name.includes("katex"));

    it("every var(--type-*) the build uses has a desktop value and an iOS value", () => {
        const used = new Set<string>();
        const desktop = new Set<string>();
        const ios = new Set<string>();
        for (const { root } of appCss()) {
            root.walkDecls((d) => {
                for (const m of d.value.matchAll(/var\((--type-[a-z0-9-]+)/g)) used.add(m[1]!);
                if (!d.prop.startsWith("--type-")) return;
                const rule = d.parent as Rule;
                if (rule.selector?.includes(":root") && !rule.selector.includes("data-ios")) desktop.add(d.prop);
                if (rule.selector?.includes("data-ios") && rule.selector.includes("body")) ios.add(d.prop);
            });
        }
        expect([...used].filter((t) => !desktop.has(t))).toEqual([]);
        expect([...used].filter((t) => !ios.has(t))).toEqual([]);
        expect(used.size).toBeGreaterThan(8);
    });

    it("the iOS scale is the system's Dynamic Type, and the text-field floor is 16px", () => {
        const all = appCss().map(({ root }) => root.toString()).join("\n");
        expect(all).toMatch(/font:\s*-apple-system-body/);
        expect(all).toMatch(/--type-field:\s*max\(16px/);
    });

    it("the app's own sheets keep no fixed px font size for text a person reads (only the root, and glyphs)", () => {
        const literal: string[] = [];
        for (const { name, root } of appCss()) {
            root.walkDecls("font-size", (d) => {
                if (!/^\d+(\.\d+)?px$/.test(d.value)) return;
                const rule = d.parent as Rule;
                const selector = rule.selector ?? "";
                // html/body (rem's base) and glyphs drawn as text (a remote cursor, an emoji reaction) are the exceptions.
                if (/^(html|body)/.test(selector) || /kvm-remote-cursor|reaction-glyph/.test(selector)) return;
                literal.push(`${name}: ${selector} { font-size: ${d.value} }`);
            });
        }
        expect(literal).toEqual([]);
    });

    it("N5: on a touch screen no text field is smaller than the floor, whatever a class says", () => {
        let rule: Rule | undefined;
        for (const { root } of built.css) {
            root.walkAtRules("media", (media) => {
                if (!/pointer:\s*coarse/.test(media.params)) return;
                media.walkRules((r) => {
                    if (r.selector.includes("textarea") && r.selector.includes("select")) rule = r;
                });
            });
        }
        expect(rule, "the coarse-pointer field rule").toBeDefined();
        let size = "";
        rule!.walkDecls("font-size", (d) => void (size = `${d.value}${d.important ? " !important" : ""}`));
        expect(size).toMatch(/var\(--type-field\)\s*!important/);
    });
});

describe("N4: the launch images", () => {
    const pngSize = (bytes: Uint8Array | string | undefined): { width: number; height: number } => {
        if (typeof bytes === "string" || bytes === undefined || !ArrayBuffer.isView(bytes)) throw new Error("not a file");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20) };
    };

    it("index.html links one image per current iPhone screen and orientation, and each file is in the build at that size", () => {
        const links = [...built.html.matchAll(/<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)"/g)];
        expect(links.length).toBe(SCREENS.length * 2);
        for (const [, href, media] of links) {
            const name = href!.replace(/^\/app\//, "");
            expect(built.files.has(name), href).toBe(true);
            const [, width, height, ratio, orientation] = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (\w+)\)/.exec(media!)!;
            const landscape = orientation === "landscape";
            expect(pngSize(built.files.get(name))).toEqual({
                width: Number(landscape ? height : width) * Number(ratio),
                height: Number(landscape ? width : height) * Number(ratio),
            });
        }
    });

    it("covers the iPhone 17 Pro (402x874 at 3x) in both orientations, and its image is the app's dark background with the icon in the middle", () => {
        const portrait = built.html.match(/href="(\/app\/splash\/[^"]+)" media="\(device-width: 402px\) and \(device-height: 874px\) and \(-webkit-device-pixel-ratio: 3\) and \(orientation: portrait\)"/);
        const landscape = built.html.match(/media="\(device-width: 402px\) and \(device-height: 874px\) and \(-webkit-device-pixel-ratio: 3\) and \(orientation: landscape\)"/);
        expect(portrait).not.toBeNull();
        expect(landscape).not.toBeNull();
        const bytes = built.files.get(portrait![1]!.replace(/^\/app\//, ""));
        expect(pngSize(bytes)).toEqual({ width: 1206, height: 2622 });
        const image = decodePng(bytes as Uint8Array);
        const at = (x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
        expect(at(2, 2)).toEqual([...SPLASH_BACKGROUND]);
        expect(at(image.width - 3, image.height - 3)).toEqual([...SPLASH_BACKGROUND]);
        // The icon's own black squircle, a touch away from the middle (the logotype is white there).
        expect(at(Math.round(image.width / 2 - 150), Math.round(image.height / 2))).toEqual([0, 0, 0]);
    });

    it("the list is the one the page links (no image is built that nothing names)", () => {
        const named = new Set(startupImages("/app/").map((i) => i.file));
        const written = [...built.files.keys()].filter((f) => f.startsWith("splash/"));
        expect(new Set(written)).toEqual(named);
    });

    it("the source icon exists for the build to draw from", () => {
        expect(readFileSync(resolve(webRoot, "public/icon-512.png")).length).toBeGreaterThan(1000);
    });
});
