import { parseChord } from "@pikvm/kvm-engine/agent";
import { z } from "zod";
import type { Desk, DeskSession, PikvmPolicy, ScreenInfo, Shot } from "./types";
import { DeskError } from "./types";

/**
 * The tools the agent sees, as `mcp__pikvm_<name>`.
 *
 * Every coordinate is a whole pixel of the reference frame: the picture the last `screenshot`
 * returned. Results are plain sentences the model reads, with the frame size spelt out each time,
 * because a model that forgets which size it is working in clicks in the wrong place.
 */

export type ToolBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
    | { readonly type: "audio"; readonly data: string; readonly mimeType: string };

/** What a tool run gives back: the blocks the model reads, and the screenshot it took, if it took one. */
export interface ToolOutput {
    readonly content: ToolBlock[];
    readonly shot?: Shot;
}

export interface ToolAnnotations {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
}

export interface Tool {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly annotations: ToolAnnotations;
    /** `observe` tools only look; `act` tools need a current screenshot behind them. */
    readonly intent: "observe" | "act";
    readonly enabled: (policy: PikvmPolicy) => boolean;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    /** Validate the model's arguments. Throws DeskError `invalid_arguments`, in words the model can fix. */
    readonly parse: (args: unknown) => Readonly<Record<string, unknown>>;
    readonly run: (desk: Desk, session: DeskSession, args: Readonly<Record<string, unknown>>) => Promise<ToolOutput>;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const INPUT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const text = (value: string): ToolOutput => ({ content: [{ type: "text", text: value }] });

/** Whole pixels: a model that does arithmetic in the frame sends 640.5, and a pixel is what it meant. */
const pixel = (description: string) => z.number().finite().min(0).transform(Math.round).describe(description);
const point = (description: string) =>
    z.object({ x: pixel("Pixel column"), y: pixel("Pixel row") }).describe(description);
const button = z.enum(["left", "right", "middle"]).default("left").describe("Mouse button. Default left.");
const region = z
    .object({
        x: pixel("Left edge"),
        y: pixel("Top edge"),
        width: z.number().finite().min(1).transform(Math.round),
        height: z.number().finite().min(1).transform(Math.round),
    })
    .describe("A rectangle of the screenshot, in its pixels");

function describeIssues(error: z.ZodError): string {
    return error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
}

function define<S extends z.ZodType>(spec: {
    name: string;
    title: string;
    description: string;
    annotations: ToolAnnotations;
    intent: "observe" | "act";
    enabled?: (policy: PikvmPolicy) => boolean;
    schema: S;
    run: (desk: Desk, session: DeskSession, args: z.output<S>) => Promise<ToolOutput>;
}): Tool {
    const { $schema: _draft, ...inputSchema } = z.toJSONSchema(spec.schema, { io: "input" }) as Record<string, unknown>;
    return {
        name: spec.name,
        title: spec.title,
        description: spec.description,
        annotations: spec.annotations,
        intent: spec.intent,
        enabled: spec.enabled ?? (() => true),
        inputSchema,
        parse(args) {
            const result = spec.schema.safeParse(args ?? {});
            if (!result.success) throw new DeskError("invalid_arguments", describeIssues(result.error));
            return result.data as Readonly<Record<string, unknown>>;
        },
        run: (desk, session, args) => spec.run(desk, session, args as z.output<S>),
    };
}

function frameWords(info: { reference: { width: number; height: number } | null }): string {
    return info.reference ? `${info.reference.width}x${info.reference.height}` : "unknown size";
}

function stateWords(shot: Pick<Shot, "mouse" | "sourceOnline" | "hidOnline">): string {
    const parts = [`Mouse: ${shot.mouse}${shot.mouse === "relative" ? " (positioning is approximate)" : ""}`];
    if (shot.sourceOnline === false) parts.push("video source OFFLINE (the target is off, asleep or unplugged)");
    if (shot.hidOnline === false) parts.push("keyboard and mouse are NOT connected to the target");
    return parts.join(". ");
}

function infoWords(info: ScreenInfo): string {
    const lines = [
        `Reference frame: ${frameWords(info)} (every coordinate uses it).`,
        `Native resolution: ${info.native ? `${info.native.width}x${info.native.height}` : "unknown"}.`,
        `Frame id: ${info.frameId ?? "none yet; take a screenshot"}.`,
        `Mouse mode: ${info.mouse}.`,
        `Video source: ${info.sourceOnline === null ? "unknown" : info.sourceOnline ? "online" : "offline"}.`,
        `Keyboard and mouse: ${info.hidOnline === null ? "unknown" : info.hidOnline ? "connected" : "not connected"}.`,
        `Control: ${{ you: "yours", another_conversation: "held by another conversation", released: "released; the person took over" }[info.control]}.`,
    ];
    return lines.join("\n");
}

const noArgs = z.object({}).strict();

export const tools: readonly Tool[] = [
    define({
        name: "screenshot",
        title: "Take a screenshot",
        description:
            "Take a fresh screenshot of the whole target screen. It becomes the reference frame: every coordinate you send is a pixel of this picture. " +
            "Take one before acting, and again after anything that may have changed the screen. " +
            "With `region` it returns a closer, more detailed view of that rectangle instead; coordinates still refer to the full screenshot, never to the zoom.",
        annotations: READ_ONLY,
        intent: "observe",
        schema: z.object({ region: region.optional() }),
        async run(desk, session, args) {
            const shot = await desk.screenshot(session, args.region);
            const where = shot.region
                ? `Zoom of x ${shot.region.x}, y ${shot.region.y}, ${shot.region.width}x${shot.region.height} of the ${shot.reference.width}x${shot.reference.height} frame, shown at ${shot.width}x${shot.height}. Coordinates still refer to the full ${shot.reference.width}x${shot.reference.height} frame.`
                : `Screen ${shot.width}x${shot.height} (frame ${shot.frameId}).`;
            return {
                content: [
                    { type: "text", text: `${where} ${stateWords(shot)}.` },
                    { type: "image", data: Buffer.from(shot.jpeg).toString("base64"), mimeType: "image/jpeg" },
                ],
                shot,
            };
        },
    }),

    define({
        name: "read_text",
        title: "Read text on screen",
        description:
            "Read the text on the screen with the PiKVM's own OCR. Exact for small or low-contrast text a screenshot makes hard to read. " +
            "Optional `region` in screenshot pixels. Slow on a full screen; prefer a region.",
        annotations: READ_ONLY,
        intent: "observe",
        enabled: (policy) => policy.ocr,
        schema: z.object({ region: region.optional() }),
        async run(desk, session, args) {
            const out = await desk.readText(session, args.region);
            return text(out.trim() ? out : "(no text found)");
        },
    }),

    define({
        name: "mouse_move",
        title: "Move the mouse",
        description: "Move the pointer to a pixel of the screenshot without clicking. Useful for hover menus and tooltips.",
        annotations: INPUT,
        intent: "act",
        schema: z.object({ x: pixel("Pixel column"), y: pixel("Pixel row") }),
        async run(desk, session, args) {
            await desk.mouseMove(session, { x: args.x, y: args.y });
            return text(`Moved the pointer to (${args.x}, ${args.y}).`);
        },
    }),

    define({
        name: "click",
        title: "Click",
        description:
            "Click at a pixel of the screenshot: move there, press and release. `count` 2 is a double click, 3 a triple click. " +
            "`button` right opens a context menu. Take a screenshot afterwards to see what happened.",
        annotations: INPUT,
        intent: "act",
        schema: z.object({
            x: pixel("Pixel column"),
            y: pixel("Pixel row"),
            button,
            count: z.number().int().min(1).max(3).default(1).describe("1 single, 2 double, 3 triple click. Default 1."),
        }),
        async run(desk, session, args) {
            await desk.click(session, { x: args.x, y: args.y }, args.button, args.count);
            const kind = args.count === 2 ? "Double-clicked" : args.count === 3 ? "Triple-clicked" : "Clicked";
            return text(`${kind} (${args.button}) at (${args.x}, ${args.y}).`);
        },
    }),

    define({
        name: "drag",
        title: "Drag",
        description:
            "Press at `from`, move to `to`, release. For moving windows, selecting text, dragging files and sliders. " +
            "The button is always released, even if the drag fails. Asks the person first.",
        annotations: DESTRUCTIVE,
        intent: "act",
        schema: z.object({ from: point("Where to press"), to: point("Where to release"), button }),
        async run(desk, session, args) {
            await desk.drag(session, args.from, args.to, args.button);
            return text(`Dragged (${args.button}) from (${args.from.x}, ${args.from.y}) to (${args.to.x}, ${args.to.y}).`);
        },
    }),

    define({
        name: "scroll",
        title: "Scroll",
        description:
            "Scroll the wheel with the pointer at a pixel of the screenshot. `dy` positive scrolls down, negative up; `dx` positive scrolls right. " +
            "Units are wheel notches, at most 30 a call. With neither given it scrolls down 3.",
        annotations: INPUT,
        intent: "act",
        schema: z.object({
            x: pixel("Pixel column"),
            y: pixel("Pixel row"),
            dx: z.number().finite().min(-30).max(30).optional().describe("Notches right (positive) or left"),
            dy: z.number().finite().min(-30).max(30).optional().describe("Notches down (positive) or up"),
        }),
        async run(desk, session, args) {
            let { dx, dy } = args;
            if (dx === undefined && dy === undefined) dy = 3;
            dx = Math.round(dx ?? 0);
            dy = Math.round(dy ?? 0);
            if (dx === 0 && dy === 0) throw new DeskError("invalid_arguments", "dx and dy are both 0, which scrolls nothing");
            await desk.scroll(session, { x: args.x, y: args.y }, dx, dy);
            return text(`Scrolled ${dy ? `${Math.abs(dy)} ${dy > 0 ? "down" : "up"}` : ""}${dx && dy ? ", " : ""}${dx ? `${Math.abs(dx)} ${dx > 0 ? "right" : "left"}` : ""} at (${args.x}, ${args.y}).`);
        },
    }),

    define({
        name: "type_text",
        title: "Type text",
        description:
            "Type text into whatever has keyboard focus, through the target's keyboard layout. A newline is the Enter key, which submits forms and runs commands: " +
            "text with a line break, or over 200 characters, asks the person first. Click the field before typing. Characters the layout has no key for are refused before any key is sent. " +
            "Returns JSON with the selected layout, kvmd default, and characters whose physical keys differ on US/UK layouts. " +
            "These are mapping diagnostics, not proof of the target OS layout or received text. Do not guess replacement keys or clear and retry without checking the target.",
        annotations: INPUT,
        intent: "act",
        schema: z.object({ text: z.string().min(1).max(5000).describe("The text to type") }),
        async run(desk, session, args) {
            const report = await desk.typeText(session, args.text);
            return text(JSON.stringify({
                requestedCharacters: args.text.length,
                ...report,
                guidance: "The target OS interprets physical keys. kvmd metadata does not confirm its layout. Check the target output before retrying.",
            }));
        },
    }),

    define({
        name: "key",
        title: "Press keys",
        description:
            'Press key chords in order, such as ["ctrl+c"], ["Enter"], ["alt+Tab"], ["ctrl+a", "ctrl+c"]. Modifiers are ctrl, alt, shift, super (the Windows or Cmd key); ' +
            "keys are letters, digits, F1-F24, Enter, Escape, Tab, Space, Backspace, Delete, Home, End, PageUp, PageDown, Up, Down, Left, Right. " +
            "Modifiers are always released. Chords that close or hijack the session (a bare super key, ctrl+alt+Delete, alt+F4, ctrl+w) ask the person first.",
        annotations: INPUT,
        intent: "act",
        schema: z.object({
            keys: z
                .array(z.string().min(1))
                .min(1)
                .max(16)
                .superRefine((chords, ctx) => {
                    chords.forEach((chord, i) => {
                        try {
                            parseChord(chord);
                        } catch (error) {
                            ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error), path: [i] });
                        }
                    });
                })
                .describe("Chords, each like ctrl+shift+t"),
        }),
        async run(desk, session, args) {
            await desk.key(session, args.keys);
            return text(`Pressed ${args.keys.join(", ")}.`);
        },
    }),

    define({
        name: "listen",
        title: "Listen to target audio",
        description:
            "Record the target's audio as a WAV clip. Default 5 seconds, at most 30 seconds. " +
            "Receive-only: does not use a microphone or interrupt browser audio/microphone sessions. " +
            "Requires PiKVM audio support and a client that accepts MCP audio content.",
        annotations: READ_ONLY,
        intent: "observe",
        schema: z.object({
            duration_ms: z.number().int().min(100).max(30_000).optional().describe("Recording duration in milliseconds"),
        }),
        async run(desk, session, args) {
            const clip = await desk.listen(session, args.duration_ms ?? 5000);
            return {
                content: [
                    { type: "text", text: `Recorded ${Math.round(clip.durationMs)} ms of target audio.` },
                    { type: "audio", data: Buffer.from(clip.wav).toString("base64"), mimeType: "audio/wav" },
                ],
            };
        },
    }),

    define({
        name: "wait",
        title: "Wait",
        description:
            "Pause, then take a screenshot to see the result. With `until_stable` it returns as soon as the screen stops changing (a page loading, an animation), " +
            "waiting at most `ms`. Without it, it sleeps for `ms`. Default 1000 ms, at most 30000.",
        annotations: READ_ONLY,
        intent: "observe",
        schema: z.object({
            ms: z.number().finite().min(0).max(30_000).optional().describe("Milliseconds"),
            until_stable: z.boolean().optional().describe("Return early once the screen has stopped changing"),
        }),
        async run(desk, session, args) {
            const stable = args.until_stable === true;
            const result = await desk.wait(session, Math.round(args.ms ?? (stable ? 5000 : 1000)), stable);
            if (!stable) return text(`Waited ${result.waitedMs} ms.`);
            return text(
                result.stable
                    ? `The screen settled after ${result.waitedMs} ms.`
                    : `The screen was still changing after ${result.waitedMs} ms.`,
            );
        },
    }),

    define({
        name: "screen_info",
        title: "Screen and control state",
        description:
            "The reference frame size, the target's native resolution, the mouse mode, whether the video source and the keyboard and mouse are online, and who holds control.",
        annotations: READ_ONLY,
        intent: "observe",
        schema: noArgs,
        async run(desk, session) {
            return text(infoWords(await desk.info(session)));
        },
    }),

    define({
        name: "power",
        title: "Power control",
        description:
            "Press the target's ATX power or reset button through the PiKVM: on, off (a short press, which asks the OS to shut down) or reset (a hard reset). " +
            "Unsaved work on the target is lost on a reset. Always asks the person first.",
        annotations: DESTRUCTIVE,
        intent: "act",
        enabled: (policy) => policy.allowPower,
        schema: z.object({ action: z.enum(["on", "off", "reset"]) }),
        async run(desk, session, args) {
            return text(await desk.power(session, args.action));
        },
    }),
];

export function findTool(name: string): Tool | undefined {
    return tools.find((t) => t.name === name);
}
