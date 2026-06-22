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
import { hasNewline, stripNewlines } from "../human-typing";
import type { BackgroundTasks } from "./background";
import type { InputTracker } from "../input-tracker";
import type { ScreenshotHistory } from "./screenshot-history";
import type { SecretsStore } from "../secrets";
import { runWatchedTyping, type Region as TypingRegion, type WatchedTypingDeps } from "./watched-typing";

function text(t: string) {
    return { type: "text" as const, text: t };
}

const RegionSchema = Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() });

const emptySchema = Type.Object({});

const ButtonSchema = Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
        description: "Mouse button (default left).",
    }),
);

export function createTools(
    control: PiKvmControl,
    deps: {
        background?: BackgroundTasks;
        tracker?: InputTracker;
        history?: ScreenshotHistory;
        secrets?: SecretsStore;
        /** Fast optical read of a cropped field (local OCR) for watched typing. */
        opticalRead?: (image: { data: string; mimeType: string }) => Promise<string>;
        /** Stronger read (vision model) to confirm a suspected mismatch. */
        opticalReadStrong?: (image: { data: string; mimeType: string }) => Promise<string>;
        /** Persist a learned fact (e.g. the target's keyboard layout). */
        remember?: (text: string) => void;
    } = {},
): AgentTool<any>[] {
    // Build the dependency bundle the watched-typing orchestrator needs from control.
    // Per-call code/secret flow through the orchestrator's opts → typeChunk(o).
    const watchedTypingDeps = (): WatchedTypingDeps => ({
        typeChunk: (t, o) =>
            control.typeText(t, {
                ...(o.signal ? { signal: o.signal } : {}),
                ...(o.code !== undefined ? { code: o.code } : {}),
                ...(o.secret ? { secret: o.secret } : {}),
                ...(o.onProgress ? { onProgress: o.onProgress } : {}),
            }),
        pressKey: (c) => {
            if (c === "Enter" || c === "NumpadEnter") throw new Error("watched typing never presses Enter");
            return control.pressKey(c);
        },
        hotkey: (cs) => {
            if (cs.includes("Enter") || cs.includes("NumpadEnter")) throw new Error("watched typing never presses Enter");
            return control.hotkey(cs);
        },
        captureGrid: () => (control.captureGrid ? control.captureGrid() : Promise.resolve(null)),
        cropField: async (r: TypingRegion) => {
            try {
                const s = await control.screenshot(r);
                return { data: s.base64, mimeType: s.mimeType };
            } catch {
                return null;
            }
        },
        opticalRead: deps.opticalRead ?? (async () => ""),
        ...(deps.opticalReadStrong ? { opticalReadStrong: deps.opticalReadStrong } : {}),
        getLayout: () => control.getLayout(),
        setLayout: (l) => control.setLayout(l),
        ...(deps.remember ? { remember: deps.remember } : {}),
        emit: (ev) => control.onTypingEvent?.(ev),
        getDimensions: () => control.getDimensions(),
    });
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
            const sid = deps.history?.add({ base64: shot.base64, mimeType: shot.mimeType, width: shot.width, height: shot.height });
            const label = p.region ? `Cropped region ${shot.width}x${shot.height} px.` : `Screen is ${shot.width}x${shot.height} px.`;
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    text(sid ? `${label} (id: ${sid})` : label),
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
        text: Type.String({
            description:
                "Text to type into the focused field. MUST be a single line - newlines are NOT typed and NEVER submit. To press Enter / submit, use press_key('Enter') as a separate, deliberate step. For multi-line content, type into a scratchpad (e.g. Notepad) and copy/paste.",
        }),
        code: Type.Optional(Type.Boolean({ description: "Treat as code (preserve indentation, code rhythm)." })),
        background: Type.Optional(
            Type.Boolean({ description: "Type in the background and return immediately with a task id (for long text)." }),
        ),
        verify_region: Type.Optional(
            { ...RegionSchema, description: "OPTIONAL frame-pixel box around the field. Typing is ALWAYS watched and verified now — it auto-finds the field from the pixels that change while typing. Pass this only when you already know the exact field box (skips auto-locate; the read-back is tighter)." } as typeof RegionSchema,
        ),
    });
    const typeText: AgentTool<typeof typeSchema> = {
        name: "type_text",
        label: "Type",
        description:
            "Type text into the focused field with humanlike timing. WATCHED + self-verifying: while typing it tracks the field's changing pixels (so it instantly knows if nothing is focused), reads the field back with vision, and self-corrects mistakes inline — including a wrong keyboard layout (it switches layout and re-types). NEVER emits Enter/newline - typing can never submit a form, send a message, or run a command (press_key('Enter') does that, deliberately). Any newlines in `text` are collapsed to spaces. If it reports the field isn't focused, click the field and try again. Set background:true for long text, then use wait_for_task / list_tasks.",
        parameters: typeSchema,
        async execute(_id, p: Static<typeof typeSchema>, signal): Promise<AgentToolResult<null>> {
            // HARD GUARDRAIL: typing never presses Enter. Warn the model so it uses
            // an explicit press_key('Enter') or a scratchpad+paste for multi-line.
            const stripped = hasNewline(p.text);
            const note = stripped
                ? " NOTE: newline(s) in your text were collapsed to spaces and NOT submitted - type_text never presses Enter. Use press_key('Enter') to submit, or a Notepad scratchpad + paste for multi-line text."
                : "";
            const intended = stripNewlines(p.text);
            const region: TypingRegion | undefined =
                p.verify_region && typeof p.verify_region.x === "number" ? (p.verify_region as TypingRegion) : undefined;
            const runOpts = {
                ...(typeof p.code === "boolean" ? { code: p.code } : {}),
                ...(region ? { verifyRegion: region } : {}),
                ...(signal ? { signal } : {}),
            };

            if (p.background && deps.background) {
                const id = deps.background.start(`Type ${p.text.length} chars`, async () => {
                    const res = await runWatchedTyping(intended, runOpts, watchedTypingDeps());
                    return res.summary;
                });
                return { content: [text(`Typing in background as ${id}. Use wait_for_task or list_tasks.${note}`)], details: null };
            }

            // Watched typing: type in humanized chunks, watch the field's pixels,
            // optically verify against intent, and self-correct (layout slips etc.).
            const res = await runWatchedTyping(intended, runOpts, watchedTypingDeps());
            let out = `${res.summary}${note}`;
            if (res.readBack) out += `\nIntended: "${intended}"\nField reads: "${res.readBack}"`;
            return { content: [text(out)], details: null };
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
        dx: Type.Optional(Type.Number({ description: "Horizontal scroll amount." })),
        dy: Type.Optional(Type.Number({ description: "Vertical scroll: positive = up, negative = down. Larger = a bigger gesture." })),
    });
    const scroll: AgentTool<typeof scrollSchema> = {
        name: "scroll",
        label: "Scroll",
        description: "Scroll like a trackpad gesture (broken into smooth ticks). Move the cursor over the area you want to scroll first.",
        parameters: scrollSchema,
        async execute(_id, p: Static<typeof scrollSchema>): Promise<AgentToolResult<null>> {
            await control.scroll(p.dx ?? 0, p.dy ?? 0);
            return { content: [text(`Scrolled (${p.dx ?? 0}, ${p.dy ?? 0}).`)], details: null };
        },
    };

    const dragSchema = Type.Object({
        fromX: Type.Number(),
        fromY: Type.Number(),
        toX: Type.Number(),
        toY: Type.Number(),
        button: ButtonSchema,
    });
    const drag: AgentTool<typeof dragSchema> = {
        name: "drag",
        label: "Drag",
        description: "Drag-and-drop: press at (fromX, fromY), move to (toX, toY) with an eased path, then release. For moving files, sliders, selecting, reordering, etc.",
        parameters: dragSchema,
        async execute(_id, p: Static<typeof dragSchema>, signal): Promise<AgentToolResult<null>> {
            await control.drag({ x: p.fromX, y: p.fromY }, { x: p.toX, y: p.toY }, (p.button as MouseButton) ?? "left", signal ? { signal } : {});
            return { content: [text(`Dragged (${p.fromX},${p.fromY}) → (${p.toX},${p.toY}).`)], details: null };
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

    const approvalSchema = Type.Object({
        action: Type.String({
            description: "Short description of the outward-facing action you want to take, e.g. 'send the email to John', 'join the Teams meeting', 'submit the form', 'save changes to the shared doc'.",
        }),
    });
    const requestApproval: AgentTool<typeof approvalSchema> = {
        name: "request_approval",
        label: "Request approval",
        description:
            "Ask the user to approve — BEFORE you do it — any action others would see or experience: sending an email/message/chat, joining or starting a meeting, posting, submitting a form, replying, sharing, editing or saving a shared/cloud document, accepting/declining invites, etc. Returns the user's decision.",
        parameters: approvalSchema,
        async execute(_id, p: Static<typeof approvalSchema>): Promise<AgentToolResult<null>> {
            // If we got here the reviewer already prompted and the user allowed it.
            return { content: [text(`Approved by the user: ${p.action}. You may proceed.`)], details: null };
        },
    };

    const tools: AgentTool<any>[] = [screenshot, ocr, moveMouse, click, doubleClick, drag, typeText, pressKey, hotkey, scroll, requestApproval];

    // Secrets: the agent can type saved credentials it is never allowed to see.
    if (deps.secrets) {
        const secrets = deps.secrets;
        const listSecrets: AgentTool<typeof emptySchema> = {
            name: "list_secrets",
            label: "List secrets",
            description:
                "List the saved secrets (e.g. passwords) with their names and the user's usage hint for each — telling you when/where to use it. You never see the values; use type_secret to enter one into the focused field.",
            parameters: emptySchema,
            async execute(): Promise<AgentToolResult<null>> {
                const items = secrets.list();
                if (!items.length) return { content: [text("No secrets are saved. The user can add them in Settings → Secrets.")], details: null };
                const lines = items.map((i) => (i.hint ? `• ${i.name} — ${i.hint}` : `• ${i.name}`));
                return { content: [text(`Saved secrets (names + usage hints, values hidden):\n${lines.join("\n")}`)], details: null };
            },
        };
        const secretSchema = Type.Object({
            name: Type.String({ description: "The exact name of a saved secret (see list_secrets)." }),
        });
        const typeSecret: AgentTool<typeof secretSchema> = {
            name: "type_secret",
            label: "Type secret",
            description:
                "Type a saved secret (e.g. a password) into the currently focused field WITHOUT seeing its value. Focus the field first. The value never enters your context or the activity log. Press Enter / click separately if needed.",
            parameters: secretSchema,
            async execute(_id, p: Static<typeof secretSchema>, signal): Promise<AgentToolResult<null>> {
                const value = secrets.get(p.name);
                if (value == null) {
                    const names = secrets.names();
                    return {
                        content: [text(`No secret named "${p.name}". Available: ${names.length ? names.join(", ") : "(none)"}.`)],
                        details: null,
                    };
                }
                // intensity 0: type precisely (no self-correcting typos — the field is masked, a
                // human can't see to fix mistakes). secret: keeps it out of the activity tracker.
                await control.typeText(value, { intensity: 0, secret: true, ...(signal ? { signal } : {}) });
                return { content: [text(`Typed the secret "${p.name}" (${value.length} chars, value hidden).`)], details: null };
            },
        };
        tools.push(listSecrets, typeSecret);
    }

    if (deps.history) {
        const history = deps.history;
        const viewSchema = Type.Object({ id: Type.String({ description: "The screenshot id, e.g. s7." }) });
        tools.push({
            name: "view_screenshot",
            label: "View past screenshot",
            description:
                "Re-view an earlier screenshot by its id (e.g. s7) to recover state — useful when an older screenshot was omitted from context but you need to see it again.",
            parameters: viewSchema,
            async execute(_id, p: any): Promise<AgentToolResult<null>> {
                const s = history.get(p.id);
                if (!s) return { content: [text(`Screenshot ${p.id} is no longer available.`)], details: null };
                return {
                    content: [
                        { type: "image", data: s.base64, mimeType: s.mimeType },
                        text(`Earlier screenshot ${p.id} (${s.width}x${s.height}).`),
                    ],
                    details: null,
                };
            },
        });
    }

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
