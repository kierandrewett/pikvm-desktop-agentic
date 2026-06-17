/**
 * PiKVM computer-use tools for the Pi agent.
 *
 * One AgentTool per control-core capability. The `screenshot` tool returns an
 * ImageContent block so the model literally sees the target screen each step.
 * These tools only actuate — authorization (reviewer) and presence-DND are
 * enforced by the runner's `beforeToolCall` gate.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PiKvmControl, MouseButton } from "../pikvm-control";
import type { BackgroundTasks } from "./background";
import type { InputTracker } from "../input-tracker";

function text(t: string) {
    return { type: "text" as const, text: t };
}

const RegionSchema = Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() });

const ButtonSchema = Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
        description: "Mouse button (default left).",
    }),
);

export function createTools(
    control: PiKvmControl,
    deps: { background?: BackgroundTasks; tracker?: InputTracker } = {},
): AgentTool<any>[] {
    const screenshotSchema = Type.Object({
        region: Type.Optional(
            Type.Object(
                {
                    x: Type.Number(),
                    y: Type.Number(),
                    width: Type.Number(),
                    height: Type.Number(),
                },
                {
                    description:
                        "Optional crop (pixels of the full frame) to zoom into a window or region — e.g. to read small text. Take a full screenshot first to find the bounds.",
                },
            ),
        ),
    });
    const screenshot: AgentTool<typeof screenshotSchema> = {
        name: "screenshot",
        label: "Screenshot",
        description:
            "Capture the current target screen, optionally cropped to a region to zoom in. ALWAYS call this before acting and after actions to verify results. Coordinates for other tools are in the pixels of the FULL frame.",
        parameters: screenshotSchema,
        async execute(_id, p: Static<typeof screenshotSchema>): Promise<AgentToolResult<{ width: number; height: number }>> {
            const shot = await control.screenshot(p.region);
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    text(p.region ? `Cropped region ${shot.width}x${shot.height} px.` : `Screen is ${shot.width}x${shot.height} px.`),
                ],
                details: { width: shot.width, height: shot.height },
            };
        },
    };

    const moveSchema = Type.Object({
        x: Type.Number({ description: "X pixel on the captured frame." }),
        y: Type.Number({ description: "Y pixel on the captured frame." }),
    });
    const moveMouse: AgentTool<typeof moveSchema> = {
        name: "move_mouse",
        label: "Move mouse",
        description: "Move the mouse cursor to a pixel coordinate on the current frame (human-eased path).",
        parameters: moveSchema,
        async execute(_id, p: Static<typeof moveSchema>, signal): Promise<AgentToolResult<null>> {
            await control.moveMouse(p.x, p.y, signal ? { signal } : {});
            return { content: [text(`Moved to (${p.x}, ${p.y}).`)], details: null };
        },
    };

    const clickSchema = Type.Object({
        x: Type.Optional(Type.Number({ description: "Optional X to move to before clicking." })),
        y: Type.Optional(Type.Number({ description: "Optional Y to move to before clicking." })),
        button: ButtonSchema,
    });
    const click: AgentTool<typeof clickSchema> = {
        name: "click",
        label: "Click",
        description: "Click the mouse, optionally moving to (x, y) first.",
        parameters: clickSchema,
        async execute(_id, p: Static<typeof clickSchema>, signal): Promise<AgentToolResult<null>> {
            if (typeof p.x === "number" && typeof p.y === "number") {
                await control.moveMouse(p.x, p.y, signal ? { signal } : {});
            }
            await control.click((p.button as MouseButton) ?? "left");
            return { content: [text("Clicked.")], details: null };
        },
    };

    const doubleClick: AgentTool<typeof clickSchema> = {
        name: "double_click",
        label: "Double-click",
        description: "Double-click the mouse, optionally moving to (x, y) first.",
        parameters: clickSchema,
        async execute(_id, p: Static<typeof clickSchema>, signal): Promise<AgentToolResult<null>> {
            if (typeof p.x === "number" && typeof p.y === "number") {
                await control.moveMouse(p.x, p.y, signal ? { signal } : {});
            }
            await control.doubleClick((p.button as MouseButton) ?? "left");
            return { content: [text("Double-clicked.")], details: null };
        },
    };

    const typeSchema = Type.Object({
        text: Type.String({ description: "Text to type. Newlines press Enter." }),
        code: Type.Optional(Type.Boolean({ description: "Treat as code (preserve indentation, code rhythm)." })),
        background: Type.Optional(
            Type.Boolean({ description: "Type in the background and return immediately with a task id (for long text)." }),
        ),
    });
    const typeText: AgentTool<typeof typeSchema> = {
        name: "type_text",
        label: "Type",
        description:
            "Type text into the focused field with humanlike timing and self-correcting typos. Final text always matches exactly. Set background:true for long text, then use wait_for_task / list_tasks.",
        parameters: typeSchema,
        async execute(_id, p: Static<typeof typeSchema>, signal): Promise<AgentToolResult<null>> {
            const codeOpt = typeof p.code === "boolean" ? { code: p.code } : {};
            if (p.background && deps.background) {
                const id = deps.background.start(`Type ${p.text.length} chars`, async (report) => {
                    await control.typeText(p.text, {
                        ...codeOpt,
                        ...(signal ? { signal } : {}),
                        onProgress: (d, t) => report(`${d}/${t} keystrokes`),
                    });
                    return `Typed ${p.text.length} characters.`;
                });
                return { content: [text(`Typing in background as ${id}. Use wait_for_task or list_tasks.`)], details: null };
            }
            await control.typeText(p.text, { ...codeOpt, ...(signal ? { signal } : {}) });
            return { content: [text(`Typed ${p.text.length} characters.`)], details: null };
        },
    };

    const keySchema = Type.Object({
        key: Type.String({ description: 'A JS KeyboardEvent.code, e.g. "Enter", "Tab", "Escape", "ArrowDown".' }),
    });
    const pressKey: AgentTool<typeof keySchema> = {
        name: "press_key",
        label: "Press key",
        description: "Press and release a single key by its JS event.code.",
        parameters: keySchema,
        async execute(_id, p: Static<typeof keySchema>): Promise<AgentToolResult<null>> {
            await control.pressKey(p.key);
            return { content: [text(`Pressed ${p.key}.`)], details: null };
        },
    };

    const hotkeySchema = Type.Object({
        codes: Type.Array(Type.String(), {
            description: 'Key codes to chord, e.g. ["ControlLeft","KeyC"] for Ctrl+C.',
        }),
    });
    const hotkey: AgentTool<typeof hotkeySchema> = {
        name: "hotkey",
        label: "Hotkey",
        description: "Press a chord of keys together (modifiers + key), then release.",
        parameters: hotkeySchema,
        async execute(_id, p: Static<typeof hotkeySchema>): Promise<AgentToolResult<null>> {
            await control.hotkey(p.codes);
            return { content: [text(`Pressed ${p.codes.join("+")}.`)], details: null };
        },
    };

    const scrollSchema = Type.Object({
        dx: Type.Optional(Type.Number({ description: "Horizontal scroll." })),
        dy: Type.Optional(Type.Number({ description: "Vertical scroll: positive up, negative down." })),
    });
    const scroll: AgentTool<typeof scrollSchema> = {
        name: "scroll",
        label: "Scroll",
        description: "Scroll the mouse wheel.",
        parameters: scrollSchema,
        async execute(_id, p: Static<typeof scrollSchema>): Promise<AgentToolResult<null>> {
            await control.scroll(p.dx ?? 0, p.dy ?? 0);
            return { content: [text(`Scrolled (${p.dx ?? 0}, ${p.dy ?? 0}).`)], details: null };
        },
    };

    const ocrSchema = Type.Object({
        region: Type.Optional(RegionSchema),
    });
    const ocr: AgentTool<typeof ocrSchema> = {
        name: "ocr",
        label: "OCR",
        description:
            "Read on-screen text precisely using PiKVM's built-in OCR. Pass a region (frame pixels) to read a specific window/area — much more reliable than guessing from a screenshot.",
        parameters: ocrSchema,
        async execute(_id, p: Static<typeof ocrSchema>): Promise<AgentToolResult<null>> {
            const out = await control.ocr(p.region);
            return { content: [text(out || "(no text recognised)")], details: null };
        },
    };

    const tools: AgentTool<any>[] = [screenshot, ocr, moveMouse, click, doubleClick, typeText, pressKey, hotkey, scroll];

    if (deps.background) {
        const bg = deps.background;
        tools.push({
            name: "list_tasks",
            label: "List tasks",
            description: "List background tasks and their progress.",
            parameters: Type.Object({}),
            async execute(): Promise<AgentToolResult<null>> {
                const list = bg.list();
                return {
                    content: [
                        text(
                            list.length
                                ? list.map((t) => `${t.id} [${t.status}] ${t.label} — ${t.progress || t.result || t.error || ""}`).join("\n")
                                : "No background tasks.",
                        ),
                    ],
                    details: null,
                };
            },
        });
        const waitSchema = Type.Object({ taskId: Type.String() });
        tools.push({
            name: "wait_for_task",
            label: "Wait for task",
            description: "Sleep until a background task completes, then return its result.",
            parameters: waitSchema,
            async execute(_id, p: any, signal): Promise<AgentToolResult<null>> {
                try {
                    const t = await bg.wait(p.taskId, signal);
                    return { content: [text(`${t.id} ${t.status}: ${t.result ?? t.error ?? ""}`)], details: null };
                } catch (e) {
                    return { content: [text(`Wait failed: ${e instanceof Error ? e.message : String(e)}`)], details: null };
                }
            },
        });
    }

    if (deps.tracker) {
        const tracker = deps.tracker;
        tools.push({
            name: "recent_activity",
            label: "Recent input",
            description:
                "See recently typed text and input activity — including what the USER typed themselves — so you can continue from what's already entered.",
            parameters: Type.Object({}),
            async execute(): Promise<AgentToolResult<null>> {
                const typed = tracker.typedText();
                const events = tracker
                    .recentEvents(12)
                    .map((e) => `${e.source}:${e.kind} ${e.detail}`)
                    .join("\n");
                return {
                    content: [text(`Recently typed (user+agent):\n${typed || "(nothing)"}\n\nRecent events:\n${events || "(none)"}`)],
                    details: null,
                };
            },
        });
    }

    return tools;
}
