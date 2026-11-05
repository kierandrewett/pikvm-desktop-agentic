/**
 * Failure mode: after a tool finishes, the header kept naming it ("Clicking") while the model worked out its next step,
 * and said Thinking only once that step's reasoning had arrived. A model that shows no reasoning text never said it at all.
 */

import type { OutputItem } from "@pikvm/chat-protocol";
import { describe, expect, it } from "vitest";
import { liveGroupLabel } from "./activity";

const call = (id: string): OutputItem =>
    ({ id: `fc-${id}`, type: "function_call", call_id: id, name: "mcp__pikvm_click", arguments: '{"x":1,"y":2}', status: "completed" }) as unknown as OutputItem;
const result = (id: string): OutputItem =>
    ({ id: `fo-${id}`, type: "function_call_output", call_id: id, output: "Clicked.", status: "completed" }) as unknown as OutputItem;

describe("the running header of a turn", () => {
    const thinking = liveGroupLabel([]);

    it("names a tool while it runs", () => {
        expect(liveGroupLabel([call("a")])).not.toBe(thinking);
    });

    it("says Thinking as soon as the tool has its result, before the next step has arrived", () => {
        expect(liveGroupLabel([call("a"), result("a")])).toBe(thinking);
    });

    it("keeps naming a call that is still running while another has finished", () => {
        expect(liveGroupLabel([call("a"), call("b"), result("b")])).toBe(liveGroupLabel([call("a")]));
    });
});
