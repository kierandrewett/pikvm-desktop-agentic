import { describe, expect, it, vi } from "vitest";
import { createPikvmMcp, type McpCaller, type PikvmMcpOptions } from "./handler";
import { MAX_LOOK_AGE_MS, MAX_PLAIN_TYPE_CHARS } from "./risk";
import { createFakeApprover, createFakeDesk, createTestClient, inProcessTransport } from "./testing/index";
import { DeskError, FRAME_META_KEY, defaultPolicy, type FrameSink, type PikvmPolicy, type ScreenWatchReport } from "./types";

function setup(overrides: Partial<PikvmMcpOptions> = {}, caller: Partial<McpCaller> = {}) {
    const desk = createFakeDesk();
    const approver = createFakeApprover("approved");
    let policy: PikvmPolicy = defaultPolicy;
    const onError = vi.fn();
    const mcp = createPikvmMcp({ desk, approver, policy: () => policy, onError, ...overrides });
    const client = createTestClient(inProcessTransport(mcp, { conversationId: "conv-1", ...caller }));
    return {
        desk,
        approver,
        client,
        onError,
        mcp,
        setPolicy(next: Partial<PikvmPolicy>) {
            policy = { ...policy, ...next };
        },
    };
}

/** Desk methods that act on the target, as opposed to `open` and `info`. */
const actions = (calls: { method: string }[]) =>
    calls.filter((c) => c.method !== "open" && c.method !== "approving").map((c) => c.method);

describe("the protocol", () => {
    it("initialize answers with a tools-only server, the model's instructions, and the version it can speak", async () => {
        const { client } = setup();
        const result = (await client.initialize()) as { protocolVersion: string; capabilities: object; instructions: string; serverInfo: { name: string } };
        expect(result.protocolVersion).toBe("2025-11-25");
        expect(result.capabilities).toEqual({ tools: { listChanged: false } });
        expect(result.serverInfo.name).toBe("pikvm");
        expect(result.instructions).toMatch(/control_released/);
    });

    it("falls back to a version it knows when the client asks for one it does not", async () => {
        const { client } = setup();
        const response = await client.request("initialize", { protocolVersion: "2031-01-01" });
        expect((response?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
    });

    it("a notification gets no reply, and an unknown method is a protocol error", async () => {
        const { mcp } = setup();
        expect(await mcp.handle({ conversationId: "c" }, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
        const response = await mcp.handle({ conversationId: "c" }, { jsonrpc: "2.0", id: 1, method: "resources/list" });
        expect(response?.error?.code).toBe(-32601);
    });

    it("lists the tools with object schemas, and hides power and OCR unless the policy offers them", async () => {
        const { client, setPolicy } = setup();
        const names = async () => (await client.listTools()).map((t) => t.name);
        expect(await names()).toContain("read_text");
        expect(await names()).not.toContain("power");
        setPolicy({ allowPower: true, ocr: false });
        expect(await names()).toContain("power");
        expect(await names()).not.toContain("read_text");
        for (const tool of await client.listTools()) {
            expect(tool.inputSchema["type"]).toBe("object");
            expect(tool.inputSchema).not.toHaveProperty("$schema");
            expect(tool.description.length).toBeGreaterThan(20);
        }
    });

    it("a tool the policy hides cannot be called either", async () => {
        const { client, desk } = setup();
        const response = await client.request("tools/call", { name: "power", arguments: { action: "reset" } });
        expect(response?.error?.code).toBe(-32602);
        expect(desk.calls).toEqual([]);
    });
});

describe("refusals reach the model as text, before the person is asked", () => {
    it("bad arguments never reach the desk or the approver", async () => {
        const { client, desk, approver } = setup();
        const result = await client.call("click", { x: "left", y: 5 });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/^invalid_arguments: x:/);
        expect(desk.calls).toEqual([]);
        expect(approver.requests).toEqual([]);
    });

    it("a chord that cannot be read is named, and nothing is sent", async () => {
        const { client, desk } = setup();
        const result = await client.call("key", { keys: ["ctrl+c", "ctrl+banana"] });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/invalid_arguments: keys\.1: "banana" is not a key name/);
        expect(desk.calls).toEqual([]);
    });

    it("a call with no conversation is refused before the desk is touched", async () => {
        const { desk, mcp } = setup();
        const client = createTestClient(inProcessTransport(mcp, { conversationId: undefined }));
        const result = await client.call("screenshot");
        expect(result.text).toMatch(/^no_conversation:/);
        expect(desk.calls).toEqual([]);
    });

    it.each([
        ["control_released", "The person took over the mouse."],
        ["stale_frame", "Take a screenshot first."],
        ["another_conversation_holds_control", "Another conversation has the desk."],
        ["target_offline", "The PiKVM is not reachable."],
    ] as const)("%s from the desk is the text of a failed result and never asks anything", async (code, message) => {
        const { client, desk, approver } = setup();
        desk.openError = new DeskError(code, message);
        const result = await client.call("drag", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
        expect(result.isError).toBe(true);
        expect(result.text).toBe(`${code}: ${message}`);
        expect(approver.requests).toEqual([]);
        expect(actions(desk.calls)).toEqual([]);
    });

    it("a DeskError raised by the action itself is a failed result", async () => {
        const { client, desk } = setup();
        desk.onAction = () => {
            throw new DeskError("control_released", "The person took over the mouse.");
        };
        const result = await client.call("click", { x: 10, y: 10 });
        expect(result).toMatchObject({ isError: true, text: "control_released: The person took over the mouse." });
    });

    it("an unexpected failure is logged for the host and reported to the model without detail", async () => {
        const { client, desk, onError } = setup();
        const boom = new Error("socket exploded: password=hunter2");
        desk.onAction = () => {
            throw boom;
        };
        const response = await client.request("tools/call", { name: "click", arguments: { x: 1, y: 1 } });
        expect(response?.error).toEqual({ code: -32603, message: "the PiKVM tool failed unexpectedly" });
        expect(onError).toHaveBeenCalledWith(boom);
    });

    it("a cancelled request is a cancellation, not a failure to log", async () => {
        const controller = new AbortController();
        const { client, desk, onError } = setup({}, { signal: controller.signal });
        desk.onAction = () => {
            controller.abort();
            throw new Error("aborted");
        };
        const response = await client.request("tools/call", { name: "click", arguments: { x: 1, y: 1 } });
        expect(response?.error?.code).toBe(-32800);
        expect(onError).not.toHaveBeenCalled();
    });
});

describe("what asks the person", () => {
    it.each([
        ["super"],
        ["win"],
        ["ctrl+alt+Delete"],
        ["Alt+F4"],
        ["ctrl+w"],
        ["ctrl+shift+Delete"],
        ["ctrl+alt+F1"],
        ["ctrl+alt+f12"],
    ])("the chord %s asks, and is sent only once approved", async (chord) => {
        const { client, desk, approver } = setup();
        const result = await client.call("key", { keys: [chord] });
        expect(result.isError).toBe(false);
        expect(approver.requests).toHaveLength(1);
        expect(approver.requests[0]).toMatchObject({ conversationId: "conv-1", tool: "key", arguments: { keys: [chord] } });
        expect(approver.requests[0]?.reasons.join(" ")).toMatch(/can close, switch or lock/);
        expect(actions(desk.calls)).toEqual(["key"]);
    });

    it.each([["ctrl+c"], ["Enter"], ["alt+Tab"], ["ctrl+shift+t"], ["ctrl+alt+f13"], ["ctrl+alt+a"], ["shift"]])(
        "the chord %s does not ask",
        async (chord) => {
            const { client, approver } = setup();
            await client.call("key", { keys: [chord] });
            expect(approver.requests).toEqual([]);
        },
    );

    it("a list asks once if any chord in it is risky", async () => {
        const { client, approver } = setup();
        await client.call("key", { keys: ["ctrl+c", "alt+F4", "ctrl+v"] });
        expect(approver.requests).toHaveLength(1);
        expect(approver.requests[0]?.reasons).toHaveLength(1);
    });

    it("any drag asks, and says what it will do", async () => {
        const { client, approver } = setup();
        await client.call("drag", { from: { x: 10, y: 20 }, to: { x: 300, y: 400 }, button: "right" });
        expect(approver.requests[0]).toMatchObject({
            tool: "drag",
            title: "Drag on the PiKVM screen?",
            summary: "Press the right button at (10, 20) and release it at (300, 400).",
        });
    });

    it("typed text asks for a line break or past 200 characters, and not for a short line", async () => {
        const { client, approver, desk } = setup();
        approver.answer = "denied";
        await client.call("type_text", { text: "hello world" });
        await client.call("type_text", { text: "a".repeat(MAX_PLAIN_TYPE_CHARS) });
        expect(approver.requests).toEqual([]);
        const multiline = await client.call("type_text", { text: "line one\nline two" });
        const long = await client.call("type_text", { text: "a".repeat(MAX_PLAIN_TYPE_CHARS + 1) });
        expect(multiline.isError).toBe(true);
        expect(long.isError).toBe(true);
        expect(actions(desk.calls)).toEqual(["typeText", "typeText"]);
    });

    it("a long typed text is shown to the person, cut at 300 characters with its length", async () => {
        const { client, approver } = setup();
        await client.call("type_text", { text: "x".repeat(500) });
        const summary = approver.requests[0]?.summary ?? "";
        expect(summary).toContain("(500 characters)");
        expect(summary.length).toBeLessThan(400);
    });

    it.each([
        ["mouse_move", { x: 5, y: 5 }],
        ["click", { x: 5, y: 5 }],
        ["scroll", { x: 5, y: 5, dy: 2 }],
        ["type_text", { text: "hi" }],
        ["key", { keys: ["Enter"] }],
    ] as const)("%s asks when there is no recent screenshot, and not when there is one", async (tool, args) => {
        const { client, approver, desk } = setup();
        desk.lookAgeMs = MAX_LOOK_AGE_MS;
        await client.call(tool, args);
        expect(approver.requests).toEqual([]);
        desk.lookAgeMs = MAX_LOOK_AGE_MS + 1;
        await client.call(tool, args);
        desk.lookAgeMs = null;
        await client.call(tool, args);
        expect(approver.requests).toHaveLength(2);
        expect(approver.requests[0]?.reasons).toEqual(["there has been no screenshot in the last 30 seconds"]);
    });

    it("never asks for looking: screenshot, read_text, wait, screen_info, even with no recent screenshot", async () => {
        const { client, approver, desk, setPolicy } = setup();
        desk.lookAgeMs = null;
        setPolicy({ approval: "always" });
        await client.call("screenshot");
        await client.call("screenshot", { region: { x: 0, y: 0, width: 100, height: 100 } });
        await client.call("read_text");
        await client.call("wait", { ms: 10 });
        await client.call("wait", { until_stable: true });
        await client.call("screen_info");
        expect(approver.requests).toEqual([]);
    });

    it("policy always asks for every input, and never asks for none but power", async () => {
        const { client, approver, setPolicy } = setup();
        setPolicy({ approval: "always", allowPower: true });
        await client.call("click", { x: 1, y: 1 });
        await client.call("mouse_move", { x: 1, y: 1 });
        expect(approver.requests.map((r) => r.tool)).toEqual(["click", "mouse_move"]);
        approver.requests.length = 0;
        setPolicy({ approval: "never" });
        await client.call("drag", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
        await client.call("key", { keys: ["alt+F4"] });
        await client.call("type_text", { text: "a\nb" });
        expect(approver.requests).toEqual([]);
        await client.call("power", { action: "reset" });
        expect(approver.requests.map((r) => r.tool)).toEqual(["power"]);
    });

    it("a changed policy applies to the very next call", async () => {
        const { client, approver, setPolicy } = setup();
        await client.call("key", { keys: ["alt+F4"] });
        setPolicy({ approval: "never" });
        await client.call("key", { keys: ["alt+F4"] });
        expect(approver.requests).toHaveLength(1);
    });
});

describe("answers", () => {
    it("a denial refuses, tells the model not to retry, and sends nothing", async () => {
        const { client, approver, desk } = setup();
        approver.answer = "denied";
        const result = await client.call("key", { keys: ["alt+F4"] });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/^approval_denied: The person declined .* Do not retry/);
        expect(actions(desk.calls)).toEqual([]);
    });

    it("nobody to ask is a refusal too, never a queued action", async () => {
        const { client, approver, desk } = setup();
        approver.answer = "unavailable";
        const result = await client.call("drag", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
        expect(result.text).toMatch(/^approval_denied: Nobody could be asked/);
        expect(actions(desk.calls)).toEqual([]);
    });

    it("the person taking over while the question is open ends the call, whatever the answer", async () => {
        const controller = new AbortController();
        const { client, approver, desk } = setup({}, { signal: controller.signal });
        approver.decide = () => {
            controller.abort(new DeskError("control_released", "The person took over the mouse."));
            return "approved";
        };
        const result = await client.call("key", { keys: ["alt+F4"] });
        expect(result.text).toBe("control_released: The person took over the mouse.");
        expect(actions(desk.calls)).toEqual([]);
    });

    it("tells the desk when it starts and stops waiting, also when the wait ends in an error", async () => {
        const { client, approver, desk } = setup();
        await client.call("key", { keys: ["alt+F4"] });
        approver.decide = () => {
            throw new Error("the chat socket closed");
        };
        await client.request("tools/call", { name: "key", arguments: { keys: ["alt+F4"] } });
        expect(desk.calls.filter((c) => c.method === "approving").map((c) => c.args)).toEqual([
            ["key", true],
            ["key", false],
            ["key", true],
            ["key", false],
        ]);
    });

    it("hands the approver the call's own signal, so a release can abandon the question", async () => {
        const controller = new AbortController();
        const { client, approver } = setup({}, { signal: controller.signal });
        await client.call("key", { keys: ["alt+F4"] });
        expect(approver.requests[0]?.signal).toBe(controller.signal);
    });
});

describe("tool results", () => {
    it("a screenshot is text with the frame size plus the image", async () => {
        const { client } = setup();
        const result = await client.call("screenshot");
        expect(result.text).toBe("Screen 1280x720 (frame 1). Mouse: absolute.");
        expect(result.image?.mimeType).toBe("image/jpeg");
        expect(Buffer.from(result.image?.data ?? "", "base64")).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    });

    it("a zoom says its coordinates are still the full frame's", async () => {
        const { client, desk } = setup();
        const result = await client.call("screenshot", { region: { x: 100.4, y: 50, width: 300, height: 200 } });
        expect(desk.calls.at(-1)).toMatchObject({ method: "screenshot", args: [{ x: 100, y: 50, width: 300, height: 200 }] });
        expect(result.text).toMatch(/Coordinates still refer to the full 1280x720 frame/);
    });

    it("whole pixels: fractional coordinates are rounded, and negative ones refused", async () => {
        const { client, desk } = setup();
        await client.call("click", { x: 640.6, y: 359.4, count: 2, button: "right" });
        expect(desk.calls.at(-1)).toMatchObject({ method: "click", args: [{ x: 641, y: 359 }, "right", 2] });
        expect((await client.call("click", { x: -1, y: 0 })).isError).toBe(true);
    });

    it("a bare scroll scrolls down 3, and a scroll of nothing is refused", async () => {
        const { client, desk } = setup();
        await client.call("scroll", { x: 10, y: 10 });
        expect(desk.calls.at(-1)).toMatchObject({ method: "scroll", args: [{ x: 10, y: 10 }, 0, 3] });
        await client.call("scroll", { x: 10, y: 10, dx: 2, dy: -4.4 });
        expect(desk.calls.at(-1)).toMatchObject({ args: [{ x: 10, y: 10 }, 2, -4] });
        const nothing = await client.call("scroll", { x: 10, y: 10, dx: 0, dy: 0 });
        expect(nothing.text).toMatch(/^invalid_arguments: dx and dy are both 0/);
        expect((await client.call("scroll", { x: 1, y: 1, dy: 31 })).isError).toBe(true);
    });

    it("wait sleeps by default and, until stable, says whether the screen settled", async () => {
        const { client, desk } = setup();
        expect((await client.call("wait")).text).toBe("Waited 1000 ms.");
        const settled = await client.call("wait", { until_stable: true });
        expect(desk.calls.at(-1)).toMatchObject({ method: "wait", args: [5000, true] });
        expect(settled.text).toBe("The screen settled after 5000 ms.");
        expect((await client.call("wait", { ms: 31_000 })).isError).toBe(true);
    });

    it("read_text returns the text, or says there was none", async () => {
        const { client } = setup();
        expect((await client.call("read_text")).text).toBe("hello");
    });
});

/** A sink that keeps what it is given, numbering the frames, as the chat server's store does. */
function sink() {
    const saved: { jpeg: Uint8Array; size: { width: number; height: number } }[] = [];
    return {
        saved,
        frames: {
            save(jpeg: Uint8Array, size: { width: number; height: number }) {
                saved.push({ jpeg, size });
                return { id: `frame${String(saved.length).padStart(12, "0")}`, ...size };
            },
        } satisfies FrameSink,
    };
}

const frameOfResult = (meta: Record<string, unknown> | undefined) => meta?.[FRAME_META_KEY];

describe("frames for the person", () => {
    it("pins the metadata key the chat server reads", () => {
        // packages/chat-protocol pins the same string; the two packages do not import each other.
        expect(FRAME_META_KEY).toBe("chat/frame");
    });

    it("a screenshot names the frame it kept, and the model still gets the image", async () => {
        const s = sink();
        const { client } = setup({}, { frames: s.frames });
        const result = await client.call("screenshot");
        expect(frameOfResult(result.meta)).toEqual({ id: "frame000000000001", width: 1280, height: 720 });
        expect(s.saved).toHaveLength(1);
        expect(s.saved[0]?.jpeg).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
        expect(result.image?.mimeType).toBe("image/jpeg");
        expect(result.text).toBe("Screen 1280x720 (frame 1). Mouse: absolute.");
    });

    it("a pointer tool names the latest whole-screen frame, and a zoom does not replace it", async () => {
        const s = sink();
        const { client } = setup({}, { frames: s.frames });
        await client.call("screenshot");
        const zoom = await client.call("screenshot", { region: { x: 0, y: 0, width: 300, height: 200 } });
        // The zoom is kept for the person to see, at its own size.
        expect(frameOfResult(zoom.meta)).toEqual({ id: "frame000000000002", width: 640, height: 360 });
        for (const [tool, args] of [
            ["click", { x: 10, y: 20 }],
            ["mouse_move", { x: 10, y: 20 }],
            ["drag", { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }],
            ["scroll", { x: 10, y: 20 }],
        ] as const) {
            const result = await client.call(tool, args);
            expect(frameOfResult(result.meta), tool).toEqual({ id: "frame000000000001", width: 1280, height: 720 });
        }
        await client.call("screenshot");
        expect(frameOfResult((await client.call("click", { x: 1, y: 1 })).meta)).toMatchObject({ id: "frame000000000003" });
        // Nothing was saved for the actions themselves.
        expect(s.saved).toHaveLength(3);
    });

    it("keys, text, waiting, info and read_text name no frame", async () => {
        const s = sink();
        const { client } = setup({}, { frames: s.frames });
        await client.call("screenshot");
        for (const [tool, args] of [
            ["key", { keys: ["Enter"] }],
            ["type_text", { text: "hi" }],
            ["wait", { ms: 10 }],
            ["screen_info", {}],
            ["read_text", {}],
        ] as const) {
            expect((await client.call(tool, args)).meta, tool).toBeUndefined();
        }
    });

    it("a click before any screenshot names none", async () => {
        const s = sink();
        const { client } = setup({}, { frames: s.frames });
        expect((await client.call("click", { x: 1, y: 1 })).meta).toBeUndefined();
    });

    it("a failed call names no frame", async () => {
        const s = sink();
        const { client, desk } = setup({}, { frames: s.frames });
        await client.call("screenshot");
        desk.onAction = () => {
            throw new DeskError("control_released", "a person took over");
        };
        const result = await client.call("click", { x: 1, y: 1 });
        expect(result.isError).toBe(true);
        expect(result.meta).toBeUndefined();
    });

    it("a conversation's click never names another conversation's frame", async () => {
        const s = sink();
        const mcp = createPikvmMcp({ desk: createFakeDesk(), approver: createFakeApprover("approved") });
        const a = createTestClient(inProcessTransport(mcp, { conversationId: "a", frames: s.frames }));
        const b = createTestClient(inProcessTransport(mcp, { conversationId: "b", frames: s.frames }));
        await a.call("screenshot");
        expect((await b.call("click", { x: 1, y: 1 })).meta).toBeUndefined();
        await b.call("screenshot");
        expect(frameOfResult((await a.call("click", { x: 1, y: 1 })).meta)).toMatchObject({ id: "frame000000000001" });
        expect(frameOfResult((await b.call("click", { x: 1, y: 1 })).meta)).toMatchObject({ id: "frame000000000002" });
    });

    it("without a sink, or when it refuses the picture, the result is what it always was", async () => {
        const none = setup();
        const plain = await none.client.call("screenshot");
        expect(plain.meta).toBeUndefined();
        expect(plain.image).toBeDefined();
        const refusing = setup({}, { frames: { save: () => undefined } });
        const refused = await refusing.client.call("screenshot");
        expect(refused.meta).toBeUndefined();
        expect(refused.image).toBeDefined();
        expect((await refusing.client.call("click", { x: 1, y: 1 })).meta).toBeUndefined();
    });

    it("remembers the latest frame of a bounded number of conversations, oldest forgotten", async () => {
        const s = sink();
        const mcp = createPikvmMcp({ desk: createFakeDesk(), approver: createFakeApprover("approved") });
        const as = (id: string) => createTestClient(inProcessTransport(mcp, { conversationId: id, frames: s.frames }));
        await as("first").call("screenshot");
        for (let i = 0; i < 70; i++) await as(`other${i}`).call("screenshot");
        expect((await as("first").call("click", { x: 1, y: 1 })).meta).toBeUndefined();
        expect((await as("other69").call("click", { x: 1, y: 1 })).meta).toBeDefined();
    });
});

describe("waiting for something to appear on the screen", () => {
    const report = (over: Partial<ScreenWatchReport> | Record<string, unknown> = {}): ScreenWatchReport =>
        ({
            id: "w-abc",
            status: "watching",
            question: "Has Sam written?",
            elapsedSeconds: 3,
            changes: 0,
            asked: 0,
            repeated: 0,
            skipped: 0,
            dropped: 0,
            bestProbability: null,
            screen: "signal",
            ...over,
        }) as ScreenWatchReport;
    const json = (text: string): Record<string, any> => JSON.parse(text);

    it("offers the three tools, and using them needs no screenshot, no approval and no input", async () => {
        const { client, desk, approver } = setup();
        const names = (await client.listTools()).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["watch_screen", "watch_result", "watch_cancel"]));
        desk.watchReport = report();
        await client.call("watch_screen", { question: "Has Sam written?" });
        await client.call("watch_result", { id: "w-abc" });
        await client.call("watch_cancel", { id: "w-abc" });
        expect(approver.requests).toEqual([]);
        expect(desk.calls.filter((c) => c.method === "open").map((c) => c.args[1])).toEqual(["observe", "observe", "observe"]);
        expect(actions(desk.calls)).toEqual(["watchScreen", "watchResult", "watchCancel"]);
    });

    it("hands the desk the question, the region and the limits, tidied, with the defaults the agent did not give", async () => {
        const { client, desk } = setup();
        desk.watchReport = report();
        await client.call("watch_screen", { question: "  Has Sam\n written?  " });
        await client.call("watch_screen", { question: "Is the build green?", region: { x: 10.4, y: 20, width: 300, height: 100 }, timeout_seconds: 120, wait_seconds: 0 });
        const asked = desk.calls.filter((c) => c.method === "watchScreen").map((c) => c.args[0]);
        expect(asked[0]).toEqual({ question: "Has Sam written?", timeoutSeconds: 600, waitSeconds: 30 });
        expect(asked[1]).toEqual({ question: "Is the build green?", region: { x: 10, y: 20, width: 300, height: 100 }, timeoutSeconds: 120, waitSeconds: 0 });
    });

    it("returns the report as JSON, and tells the agent what to do next whichever way it ended", async () => {
        const { client, desk } = setup();
        const next = async (over: Record<string, unknown>) => {
            desk.watchReport = report(over);
            return json((await client.call("watch_result", { id: "w-abc" })).text);
        };
        const watching = await next({});
        expect(watching).toMatchObject({ id: "w-abc", status: "watching", asked: 0, bestProbability: null });
        expect(watching["guidance"]).toContain("watch_result");
        const matched = await next({ status: "matched", asked: 2, bestProbability: 0.93, match: { probability: 0.93, excerpt: "Sam Rowe / Are you free?", atSeconds: 41 } });
        expect(matched).toMatchObject({ status: "matched", match: { probability: 0.93, excerpt: "Sam Rowe / Are you free?" } });
        expect(matched["guidance"]).toContain("screenshot");
        for (const status of ["timed_out", "cancelled", "failed"]) {
            const ended = await next({ status, reason: "because" });
            expect(ended).toMatchObject({ status, reason: "because" });
            expect(ended["guidance"]).not.toContain("watch_result");
        }
    });

    it.each([
        ["an empty question", "watch_screen", { question: "   " }],
        ["a question over 500 characters", "watch_screen", { question: "x".repeat(501) }],
        ["a time under 10 seconds", "watch_screen", { question: "q", timeout_seconds: 5 }],
        ["a time over an hour", "watch_screen", { question: "q", timeout_seconds: 3601 }],
        ["a wait over 50 seconds", "watch_screen", { question: "q", wait_seconds: 51 }],
        ["a wait in the past", "watch_result", { id: "w-abc", wait_seconds: -1 }],
        ["no id", "watch_result", {}],
        ["no id to cancel", "watch_cancel", {}],
    ] as const)("%s never reaches the desk", async (_name, tool, args) => {
        const { client, desk } = setup();
        const result = await client.call(tool, args);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/^invalid_arguments:/);
        expect(desk.calls).toEqual([]);
    });

    it.each([
        ["watch_unavailable", "Screen waits need a Decisions model, and none is set."],
        ["no_such_watch", "No screen wait has that id."],
    ] as const)("%s from the desk is the text of a failed result", async (code, message) => {
        const { client, desk } = setup();
        desk.watchError = new DeskError(code, message);
        const result = await client.call("watch_screen", { question: "Has Sam written?" });
        expect(result).toMatchObject({ isError: true, text: `${code}: ${message}` });
    });
});
