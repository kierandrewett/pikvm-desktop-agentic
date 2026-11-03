import { describe, expect, it } from "vitest";
import { FRAME_META_KEY, frameFromMeta, frameMeta, frameUrl, type FunctionCallOutputItem } from "./index.ts";

const ref = { id: "m3k9x1abc0def1234", width: 1280, height: 720 };

describe("frames in a tool result", () => {
    it("pins the metadata key both ends use", () => {
        // packages/pikvm-mcp writes this literal; its test pins the same string.
        expect(FRAME_META_KEY).toBe("chat/frame");
    });

    it("round trips through the JSON a result is sent as", () => {
        const sent = JSON.parse(JSON.stringify(frameMeta(ref)));
        expect(frameFromMeta(sent)).toEqual(ref);
    });

    it("round trips as an output item, live and from history alike", () => {
        const item: FunctionCallOutputItem = {
            id: "o1",
            type: "function_call_output",
            status: "completed",
            call_id: "k1",
            output: "Screen 1280x720 (frame 1). Mouse: absolute.",
            frame: { ...ref, url: frameUrl("c1", ref.id) },
        };
        const back = JSON.parse(JSON.stringify(item)) as FunctionCallOutputItem;
        expect(back.frame).toEqual({ ...ref, url: `/api/conversations/c1/frames/${ref.id}` });
    });

    it("names no frame for a result without one, and for a value that is not a reference", () => {
        for (const meta of [
            undefined,
            null,
            "chat/frame",
            {},
            { [FRAME_META_KEY]: null },
            { [FRAME_META_KEY]: "x" },
            // an id that could leave its directory, or is not an id at all
            { [FRAME_META_KEY]: { ...ref, id: "../../etc/passwd" } },
            { [FRAME_META_KEY]: { ...ref, id: "UPPERCASE0000000000" } },
            { [FRAME_META_KEY]: { ...ref, id: "short" } },
            { [FRAME_META_KEY]: { ...ref, id: 12345678901234 } },
            // a size that is not a whole positive number of pixels
            { [FRAME_META_KEY]: { ...ref, width: 0 } },
            { [FRAME_META_KEY]: { ...ref, height: -1 } },
            { [FRAME_META_KEY]: { ...ref, width: 1.5 } },
            { [FRAME_META_KEY]: { ...ref, width: "1280" } },
            { [FRAME_META_KEY]: { ...ref, height: 10 ** 9 } },
        ]) {
            expect(frameFromMeta(meta), JSON.stringify(meta)).toBeUndefined();
        }
    });

    it("keeps only the three fields it knows", () => {
        const meta = { [FRAME_META_KEY]: { ...ref, extra: "<script>" } };
        expect(frameFromMeta(meta)).toEqual(ref);
    });
});
