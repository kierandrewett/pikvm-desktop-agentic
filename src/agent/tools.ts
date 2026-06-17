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

function text(t: string) {
    return { type: "text" as const, text: t };
}

const ButtonSchema = Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
        description: "Mouse button (default left).",
    }),
);

export function createTools(control: PiKvmControl): AgentTool<any>[] {
    const screenshotSchema = Type.Object({});
    const screenshot: AgentTool<typeof screenshotSchema> = {
        name: "screenshot",
        label: "Screenshot",
        description:
            "Capture the current target screen. ALWAYS call this before acting and after actions to verify results. Coordinates for other tools are in the pixels of the returned image.",
        parameters: screenshotSchema,
        async execute(): Promise<AgentToolResult<{ width: number; height: number }>> {
            const shot = await control.screenshot();
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    text(`Screen is ${shot.width}x${shot.height} px.`),
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
    });
    const typeText: AgentTool<typeof typeSchema> = {
        name: "type_text",
        label: "Type",
        description:
            "Type text into the focused field with humanlike timing and self-correcting typos. Final text always matches exactly.",
        parameters: typeSchema,
        async execute(_id, p: Static<typeof typeSchema>, signal): Promise<AgentToolResult<null>> {
            await control.typeText(p.text, {
                ...(typeof p.code === "boolean" ? { code: p.code } : {}),
                ...(signal ? { signal } : {}),
            });
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

    return [screenshot, moveMouse, click, doubleClick, typeText, pressKey, hotkey, scroll];
}
