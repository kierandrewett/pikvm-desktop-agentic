import { existsSync, readdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../../test/temp.ts";
import { builtinContext } from "../mcp/builtin.ts";
import { configurePaths, paths } from "../paths.ts";
import {
    copyFrames,
    frameFile,
    FrameError,
    MAX_FRAME_BYTES,
    MAX_FRAMES,
    MAX_TOTAL_BYTES,
    removeFrames,
    saveFrame,
} from "./frames.ts";

let dir: string;
beforeAll(() => {
    dir = tempDir("chat-frames-");
    configurePaths(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIZE = { width: 320, height: 180 };
const jpeg = (bytes = 8) => {
    const b = new Uint8Array(bytes);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    return b;
};
const files = (conversation: string) => {
    const d = paths.user("operator").frames(conversation);
    return existsSync(d) ? readdirSync(d).sort() : [];
};

describe("keeping a frame", () => {
    it("writes the picture where the route looks for it and names it by an id that sorts by time", () => {
        const a = saveFrame("operator", "c-order", jpeg(), SIZE);
        const b = saveFrame("operator", "c-order", jpeg(), SIZE);
        expect(a).toMatchObject(SIZE);
        expect(a.id < b.id).toBe(true);
        expect(frameFile("operator", "c-order", a.id)).toBe(`${paths.user("operator").frames("c-order")}/${a.id}.jpg`);
    });

    it("refuses what is not a picture of a size it can show, and leaves nothing behind", () => {
        for (const [what, bytes, size] of [
            ["a text file", new TextEncoder().encode("<script>alert(1)</script>"), SIZE],
            ["an empty body", new Uint8Array(0), SIZE],
            ["a PNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), SIZE],
            ["a picture over the limit", jpeg(MAX_FRAME_BYTES + 1), SIZE],
            ["a zero width", jpeg(), { width: 0, height: 180 }],
            ["a fractional height", jpeg(), { width: 320, height: 1.5 }],
            ["an absurd size", jpeg(), { width: 100_000, height: 100_000 }],
        ] as const) {
            expect(() => saveFrame("operator", "c-refused", bytes, size), what).toThrow(FrameError);
        }
        expect(files("c-refused")).toEqual([]);
    });

    it("refuses a conversation id that could leave its directory", () => {
        expect(() => saveFrame("operator", "../../etc", jpeg(), SIZE)).toThrow(/unsafe conversation id/);
    });
});

describe("the bound", () => {
    it("keeps at most MAX_FRAMES, the newest, and drops the oldest first", () => {
        const ids = Array.from({ length: MAX_FRAMES + 7 }, () => saveFrame("operator", "c-count", jpeg(), SIZE).id);
        const left = files("c-count");
        expect(left).toHaveLength(MAX_FRAMES);
        expect(left).toEqual(ids.slice(7).map((id) => `${id}.jpg`));
        expect(frameFile("operator", "c-count", ids[0]!)).toBeUndefined();
        expect(frameFile("operator", "c-count", ids.at(-1)!)).toBeDefined();
    });

    it("keeps at most MAX_TOTAL_BYTES, and never drops the frame it just wrote", () => {
        const per = MAX_FRAME_BYTES;
        const n = Math.floor(MAX_TOTAL_BYTES / per) + 3;
        const ids = Array.from({ length: n }, () => saveFrame("operator", "c-bytes", jpeg(per), SIZE).id);
        const left = files("c-bytes");
        expect(left.length * per).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
        expect(left.length).toBeGreaterThan(1);
        expect(left.at(-1)).toBe(`${ids.at(-1)}.jpg`);
        expect(frameFile("operator", "c-bytes", ids[0]!)).toBeUndefined();
    });

    it("bounds each conversation on its own", () => {
        const other = saveFrame("operator", "c-other", jpeg(), SIZE);
        for (let i = 0; i < MAX_FRAMES + 2; i++) saveFrame("operator", "c-busy", jpeg(), SIZE);
        expect(frameFile("operator", "c-other", other.id)).toBeDefined();
    });
});

describe("finding a frame", () => {
    it("never finds another conversation's frame, an id that is not one, or a pruned frame", () => {
        const mine = saveFrame("operator", "c-mine", jpeg(), SIZE);
        expect(frameFile("operator", "c-mine", mine.id)).toBeDefined();
        expect(frameFile("operator", "c-theirs", mine.id)).toBeUndefined();
        for (const bad of ["", "..", "../c-mine/" + mine.id, mine.id + ".jpg", mine.id.toUpperCase(), "x".repeat(200), `${mine.id}\0`])
            expect(frameFile("operator", "c-mine", bad), bad).toBeUndefined();
        expect(frameFile("operator", "c-mine", "0".repeat(20))).toBeUndefined();
    });
});

describe("a conversation's frames follow the conversation", () => {
    it("are deleted with it", () => {
        const a = saveFrame("operator", "c-gone", jpeg(), SIZE);
        removeFrames("operator", "c-gone");
        expect(existsSync(paths.user("operator").frames("c-gone"))).toBe(false);
        expect(frameFile("operator", "c-gone", a.id)).toBeUndefined();
        // Deleting what is not there is not an error.
        expect(() => removeFrames("operator", "c-gone")).not.toThrow();
    });

    it("are copied to a fork, and the fork's frames are its own afterwards", () => {
        const a = saveFrame("operator", "c-src", jpeg(), SIZE);
        copyFrames("operator", "c-src", "c-fork");
        expect(frameFile("operator", "c-fork", a.id)).toBeDefined();
        removeFrames("operator", "c-src");
        expect(frameFile("operator", "c-fork", a.id)).toBeDefined();
        // A chat that never took a picture has nothing to copy.
        expect(() => copyFrames("operator", "c-none", "c-fork2")).not.toThrow();
    });
});

describe("the context a built-in server gets", () => {
    it("keeps a picture for its own conversation, and says so with a reference", () => {
        const ref = builtinContext("operator", "c-ctx").saveFrame(jpeg(), SIZE);
        expect(ref).toMatchObject(SIZE);
        expect(frameFile("operator", "c-ctx", ref!.id)).toBeDefined();
    });

    it("keeps nothing without a conversation, and refuses a bad picture without throwing", () => {
        expect(builtinContext("operator", undefined).saveFrame(jpeg(), SIZE)).toBeUndefined();
        expect(builtinContext("operator", "c-ctx2").saveFrame(new Uint8Array([1, 2, 3, 4, 5]), SIZE)).toBeUndefined();
        expect(files("c-ctx2")).toEqual([]);
    });
});
