/**
 * Integrated MCP server — PiKVM "eyes + hands" for Claude Code.
 *
 * Exposes the PiKVM control core as MCP tools so Claude Code (running in the embedded
 * terminal) can see and drive the target: screenshot, OCR, region map, and the full
 * mouse/keyboard surface incl. watched/self-correcting typing and credential entry.
 *
 * Guardrails: actions are gated by presence (DND) here; APPROVAL of risky/sensitive
 * ops is handled by Claude Code's own permission prompts, driven by our reviewer via
 * the PreToolUse hook → /_agent/api/permcheck. So this server does NOT prompt.
 *
 * Hosted over Streamable HTTP at /_agent/mcp on the local control server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";
import type { PiKvmControl, MouseButton } from "./pikvm-control";
import type { OperationReviewer } from "./reviewer";
import type { PresenceMonitor } from "./presence";
import type { SecretsStore } from "./secrets";
import type { RegionsResult } from "./agent/regions";
import { runWatchedTyping, type Region as TypingRegion, type WatchedTypingDeps } from "./agent/watched-typing";

export interface McpDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    /** Named credential vault — Claude Code can type secrets it never sees. */
    secrets: SecretsStore;
    /** Cached, change-gated screen-region map (labelled UI areas with boxes). */
    getRegions: () => RegionsResult | null;
    /** Fast local OCR read-back for watched typing (vision confirms a mismatch). */
    opticalRead?: (image: { data: string; mimeType: string }) => Promise<string>;
    opticalReadStrong?: (image: { data: string; mimeType: string }) => Promise<string>;
    /** Persist a learned fact (e.g. the target's keyboard layout). */
    remember?: (text: string) => void;
}

const region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export function createMcpServer(deps: McpDeps): McpServer {
    const server = new McpServer(
        { name: "pikvm", version: "2.0.0" },
        {
            instructions:
                "Drive a real computer through PiKVM. ALWAYS screenshot first; coordinates are full-frame pixels. " +
                "Use ocr to read text, get_regions to know where windows/taskbars/terminals are. type_text is watched + " +
                "self-correcting and NEVER presses Enter (use press_key('Enter') to submit). Use type_secret for passwords. " +
                "Risky/sensitive actions will ask for your approval in this terminal.",
        },
    );

    // The watched-typing orchestrator's dependency bundle (mirrors the agent's).
    const watchedTypingDeps = (): WatchedTypingDeps => ({
        typeChunk: (t, o) =>
            deps.control.typeText(t, {
                ...(o.signal ? { signal: o.signal } : {}),
                ...(o.code !== undefined ? { code: o.code } : {}),
                ...(o.secret ? { secret: o.secret } : {}),
                ...(o.onProgress ? { onProgress: o.onProgress } : {}),
            }),
        pressKey: (c) => {
            if (c === "Enter" || c === "NumpadEnter") throw new Error("watched typing never presses Enter");
            return deps.control.pressKey(c);
        },
        hotkey: (cs) => {
            if (cs.includes("Enter") || cs.includes("NumpadEnter")) throw new Error("watched typing never presses Enter");
            return deps.control.hotkey(cs);
        },
        captureGrid: () => (deps.control.captureGrid ? deps.control.captureGrid() : Promise.resolve(null)),
        cropField: async (r: TypingRegion) => {
            try {
                const s = await deps.control.screenshot(r);
                return { data: s.base64, mimeType: s.mimeType };
            } catch {
                return null;
            }
        },
        opticalRead: deps.opticalRead ?? (async () => ""),
        ...(deps.opticalReadStrong ? { opticalReadStrong: deps.opticalReadStrong } : {}),
        getLayout: () => deps.control.getLayout(),
        setLayout: (l) => deps.control.setLayout(l),
        ...(deps.remember ? { remember: deps.remember } : {}),
        emit: (ev) => deps.control.onTypingEvent?.(ev),
        getDimensions: () => deps.control.getDimensions(),
    });

    // Presence (DND) gate only — approval is Claude Code's job (via the permcheck hook).
    const yieldToPresence = () => deps.presence.waitUntilAllowed();
    const ok = (text: string): any => ({ content: [{ type: "text", text }] });

    server.registerTool(
        "screenshot",
        {
            description: "Capture the current target screen as a JPEG, optionally cropped to a region to zoom in. Call before and after actions.",
            inputSchema: { region: region.optional() },
        },
        async ({ region: r }): Promise<any> => {
            const shot = await deps.control.screenshot(r);
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    { type: "text", text: r ? `Cropped region ${shot.width}x${shot.height} px.` : `Screen is ${shot.width}x${shot.height} px.` },
                ],
            } as any;
        },
    );

    server.registerTool(
        "ocr",
        { description: "Read on-screen text via the target's built-in OCR, optionally within a region. Faster/cheaper than reading a screenshot for plain text.", inputSchema: { region: region.optional() } },
        async ({ region: r }): Promise<any> => {
            const out = await deps.control.ocr(r);
            return ok(out.trim() ? out : "(no text found)");
        },
    );

    server.registerTool(
        "get_regions",
        { description: "List the salient UI regions of the current screen — label, kind (taskbar/window/terminal/browser/emulator/panel/dialog/menu), and a full-frame bounding box. Use it to know WHERE you are and to find a window before clicking/cropping.", inputSchema: {} },
        async (): Promise<any> => {
            const res = deps.getRegions();
            if (!res || !res.regions.length) return ok("No screen regions available yet — take a screenshot first, then try again.");
            const lines = res.regions.map((r) => `• ${r.label} [${r.kind}] — x=${r.bbox.x}, y=${r.bbox.y}, ${r.bbox.width}x${r.bbox.height}`);
            return ok(`Screen regions (frame ${res.width}x${res.height} px, origin top-left):\n${lines.join("\n")}`);
        },
    );

    server.registerTool(
        "move_mouse",
        { description: "Move the mouse to a pixel coordinate on the current frame.", inputSchema: { x: z.number(), y: z.number() } },
        async ({ x, y }): Promise<any> => {
            await yieldToPresence();
            await deps.control.moveMouse(x, y);
            return ok(`Moved to (${x}, ${y}).`);
        },
    );

    const clickShape = { x: z.number().optional(), y: z.number().optional(), button: z.enum(["left", "right", "middle"]).optional() };
    server.registerTool(
        "click",
        { description: "Click, optionally moving to (x, y) first.", inputSchema: clickShape },
        async ({ x, y, button }): Promise<any> => {
            await yieldToPresence();
            if (typeof x === "number" && typeof y === "number") await deps.control.moveMouse(x, y);
            await deps.control.click((button as MouseButton) ?? "left");
            return ok("Clicked.");
        },
    );

    server.registerTool(
        "double_click",
        { description: "Double-click, optionally moving to (x, y) first.", inputSchema: clickShape },
        async ({ x, y, button }): Promise<any> => {
            await yieldToPresence();
            if (typeof x === "number" && typeof y === "number") await deps.control.moveMouse(x, y);
            await deps.control.doubleClick((button as MouseButton) ?? "left");
            return ok("Double-clicked.");
        },
    );

    server.registerTool(
        "drag",
        { description: "Drag from (fromX, fromY) to (toX, toY) holding a mouse button — for sliders, selections, drag-and-drop.", inputSchema: { fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), button: z.enum(["left", "right", "middle"]).optional() } },
        async ({ fromX, fromY, toX, toY, button }): Promise<any> => {
            await yieldToPresence();
            await deps.control.drag({ x: fromX, y: fromY }, { x: toX, y: toY }, (button as MouseButton) ?? "left");
            return ok(`Dragged (${fromX},${fromY}) → (${toX},${toY}).`);
        },
    );

    server.registerTool(
        "type_text",
        {
            description: "Type text into the focused field — WATCHED + self-correcting (tracks the field's changing pixels, reads it back, fixes layout slips). NEVER presses Enter (newlines collapse to spaces); use press_key('Enter') to submit. If it reports the field isn't focused, click it first.",
            inputSchema: { text: z.string(), code: z.boolean().optional(), verify_region: region.optional() },
        },
        async ({ text, code, verify_region }): Promise<any> => {
            await yieldToPresence();
            const intended = String(text).replace(/[\r\n]+/g, " ");
            const res = await runWatchedTyping(
                intended,
                { ...(typeof code === "boolean" ? { code } : {}), ...(verify_region ? { verifyRegion: verify_region as TypingRegion } : {}) },
                watchedTypingDeps(),
            );
            let out = res.summary;
            if (res.readBack) out += `\nIntended: "${intended}"\nField reads: "${res.readBack}"`;
            return ok(out);
        },
    );

    server.registerTool(
        "press_key",
        { description: 'Press a single key by JS event.code (e.g. "Enter", "Tab", "ArrowDown"). This is how you submit (Enter).', inputSchema: { key: z.string() } },
        async ({ key }): Promise<any> => {
            await yieldToPresence();
            await deps.control.pressKey(key);
            return ok(`Pressed ${key}.`);
        },
    );

    server.registerTool(
        "hotkey",
        { description: 'Press a chord, e.g. ["ControlLeft","KeyC"] for Ctrl+C.', inputSchema: { codes: z.array(z.string()) } },
        async ({ codes }): Promise<any> => {
            await yieldToPresence();
            await deps.control.hotkey(codes);
            return ok(`Pressed ${codes.join("+")}.`);
        },
    );

    server.registerTool(
        "scroll",
        { description: "Scroll the wheel. dy positive = up.", inputSchema: { dx: z.number().optional(), dy: z.number().optional() } },
        async ({ dx, dy }): Promise<any> => {
            await yieldToPresence();
            await deps.control.scroll(dx ?? 0, dy ?? 0);
            return ok(`Scrolled (${dx ?? 0}, ${dy ?? 0}).`);
        },
    );

    server.registerTool(
        "list_secrets",
        { description: "List saved secrets (names + the user's usage hint for each). You never see the values — use type_secret to enter one into a focused field.", inputSchema: {} },
        async (): Promise<any> => {
            const items = deps.secrets.list();
            if (!items.length) return ok("No secrets saved.");
            return ok(items.map((s) => `• ${s.name}${s.hint ? ` — ${s.hint}` : ""}`).join("\n"));
        },
    );

    server.registerTool(
        "type_secret",
        { description: "Type a saved secret (e.g. a password) into the focused field WITHOUT seeing its value. Focus the field first. The value never enters your context. Press Enter / click separately if needed.", inputSchema: { name: z.string() } },
        async ({ name }): Promise<any> => {
            await yieldToPresence();
            const value = deps.secrets.get(name);
            if (value == null) {
                const names = deps.secrets.names();
                return ok(`No secret named "${name}". Available: ${names.length ? names.join(", ") : "(none)"}.`);
            }
            await deps.control.typeText(value, { intensity: 0, secret: true });
            return ok(`Typed the secret "${name}" (${value.length} chars, value hidden).`);
        },
    );

    return server;
}

/**
 * Build a Streamable-HTTP request handler for the MCP server. Stateless
 * (sessionIdGenerator undefined) so each request stands alone — simplest for a
 * single local client (Claude Code in the embedded terminal).
 */
export function createMcpHttpHandler(deps: McpDeps) {
    return async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
        const server = createMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport as any);
        await transport.handleRequest(req, res, body);
    };
}
