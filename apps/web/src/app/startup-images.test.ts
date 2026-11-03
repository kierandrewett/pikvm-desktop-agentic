/**
 * The launch-image generator's own parts (the build's output is audited in native-feel-build.test.ts).
 *
 * Failure modes:
 *  S1. A screen is missing, listed twice, or its media query does not match the device iOS reports (iOS shows no
 *      image at all for a query that is off by a pixel).
 *  S2. The icon decoder or the PNG writer corrupts the picture (a wrong filter, a wrong palette, a bad chunk checksum).
 *  S3. The splash is not the app's background with the icon centred.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, renderSplash, SCREENS, SPLASH_BACKGROUND, startupImageLinks, startupImages } from "../../startup-images";

const icon = decodePng(readFileSync(resolve(import.meta.dirname, "../../public/icon-512.png")));

describe("S1: the list", () => {
    it("has the iPhone 17 line, the 16, 15, 14, 13, 12, 11, X and the SE, with no screen twice", () => {
        const keys = SCREENS.map((s) => `${s.width}x${s.height}@${s.ratio}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const wanted of ["440x956@3", "402x874@3", "420x912@3", "430x932@3", "393x852@3", "390x844@3", "428x926@3", "375x812@3", "414x896@3", "414x896@2", "414x736@3", "375x667@2"]) {
            expect(keys, wanted).toContain(wanted);
        }
    });

    it("makes a portrait and a landscape image of every screen, at width x ratio by height x ratio, with the device's own query", () => {
        const images = startupImages("/app/");
        expect(images).toHaveLength(SCREENS.length * 2);
        const phone = images.find((i) => i.media.includes("402px") && i.orientation === "portrait")!;
        expect(phone).toMatchObject({ pixelWidth: 1206, pixelHeight: 2622, href: "/app/splash/apple-splash-portrait-3x-402x874.png" });
        expect(phone.media).toBe("(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)");
        const sideways = images.find((i) => i.media.includes("402px") && i.orientation === "landscape")!;
        // iOS reports the device's width and height the same way up in either orientation; only the picture turns.
        expect(sideways).toMatchObject({ pixelWidth: 2622, pixelHeight: 1206 });
        expect(sideways.media).toContain("(device-width: 402px) and (device-height: 874px)");
        expect(new Set(images.map((i) => i.file)).size).toBe(images.length);
    });

    it("writes one link tag a line, with the href and the media quoted", () => {
        const html = startupImageLinks(startupImages("/app/", SCREENS.slice(0, 1)));
        expect(html.split("\n")).toHaveLength(2);
        expect(html).toMatch(/^<link rel="apple-touch-startup-image" href="\/app\/splash\/[^"]+\.png" media="\(device-width: 440px\)[^"]+" \/>/);
    });
});

describe("S2: the PNG code", () => {
    it("decodes the app icon: 512 square, opaque, the rounded corner in the background colour, black inside", () => {
        expect(icon.width).toBe(512);
        expect(icon.height).toBe(512);
        const at = (x: number, y: number): number[] => [...icon.data.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];
        expect(at(2, 2)).toEqual([10, 10, 12, 255]);
        expect(at(256, 20)).toEqual([0, 0, 0, 255]);
    });

    it("encodes what it decodes: a gradient round-trips pixel for pixel through every filter the decoder reads", () => {
        const width = 7;
        const height = 5;
        const rgb = new Uint8Array(width * height * 3).map((_, i) => (i * 37) % 256);
        const png = encodePng(width, height, rgb);
        const back = decodePng(png);
        expect([back.width, back.height]).toEqual([width, height]);
        for (let i = 0; i < width * height; i++) expect([...back.data.subarray(i * 4, i * 4 + 4)]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]);
    });

    it("writes chunks with their checksums, and a body that inflates to the rows", () => {
        const png = encodePng(2, 2, new Uint8Array(12).fill(7));
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const length = png.readUInt32BE(8 + 8 + 13 + 4);
        const body = png.subarray(8 + 8 + 13 + 4 + 8, 8 + 8 + 13 + 4 + 8 + length);
        expect(inflateSync(body)).toHaveLength(2 * (1 + 6));
    });

    it("refuses a file that is not a PNG, or one it cannot read faithfully", () => {
        expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a PNG/);
        const sixteenBit = Buffer.from(encodePng(1, 1, new Uint8Array(3)));
        sixteenBit[24] = 16;
        expect(() => decodePng(sixteenBit)).toThrow(/16-bit/);
    });
});

describe("S3: the splash", () => {
    const splash = decodePng(renderSplash(icon, 1206, 2622));
    const at = (x: number, y: number): number[] => [...splash.data.subarray((y * splash.width + x) * 4, (y * splash.width + x) * 4 + 3)];

    it("is the app's background everywhere but the icon", () => {
        for (const [x, y] of [[0, 0], [1205, 0], [0, 2621], [1205, 2621], [600, 300], [100, 1300]] as const) expect(at(x, y)).toEqual([...SPLASH_BACKGROUND]);
    });

    it("has the icon in the middle, 30% of the width: its black body and its white lettering", () => {
        expect(at(603 - 150, 1311)).toEqual([0, 0, 0]);
        // Somewhere across the lettering is white.
        let white = 0;
        for (let x = 603 - 110; x < 603 + 110; x++) if (at(x, 1311).every((c) => c > 200)) white++;
        expect(white).toBeGreaterThan(20);
        // The icon is 362 px wide (0.3 of 1206): just outside it is the background again.
        expect(at(603 - 190, 1311)).toEqual([...SPLASH_BACKGROUND]);
    });

    it("is small: a flat picture compresses to a few tens of kB", () => {
        expect(renderSplash(icon, 1206, 2622).length).toBeLessThan(60_000);
    });
});
