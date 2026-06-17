/**
 * Integrated MCP server.
 *
 * Exposes the PiKVM control core as MCP tools so any external MCP client (the
 * user's own Codex/Claude, etc.) can drive the target — the same capability set
 * the embedded Pi agent uses. Every tool goes through the operation reviewer
 * and presence-DND gate before it actuates.
 *
 * Hosted over Streamable HTTP at /mcp on the local control server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";
import type { PiKvmControl, MouseButton } from "./pikvm-control";
import type { OperationReviewer, Operation } from "./reviewer";
import type { PresenceMonitor } from "./presence";

export interface McpDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
}

type TextOrImage = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
    content: TextOrImage[];
    isError?: boolean;
}

export function createMcpServer(deps: McpDeps): McpServer {
    const server = new McpServer(
        { name: "pikvm", version: "1.0.0" },
        { instructions: "Control a real computer through PiKVM: screenshot the screen, then move/click/type." },
    );

    /** Presence + reviewer gate shared by every MCP tool. */
    async function gate(tool: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; why: string }> {
        await deps.presence.waitUntilAllowed();
        const op: Operation = { tool, args, source: "mcp" };
        const verdict = await deps.reviewer.review(op);
        if (verdict.decision === "allow") return { ok: true };
        if (verdict.decision === "redirect")
            return { ok: false, why: `User redirected: ${verdict.text ?? "do something different"}` };
        return { ok: false, why: verdict.reason ?? "Blocked by reviewer." };
    }

    const blocked = (why: string): any => ({ content: [{ type: "text", text: `BLOCKED: ${why}` }], isError: true });
    const ok = (text: string): any => ({ content: [{ type: "text", text }] });

    server.registerTool(
        "screenshot",
        {
            description: "Capture the current target screen as a JPEG. Call before and after actions.",
            inputSchema: {},
        },
        async (): Promise<any> => {
            const shot = await deps.control.screenshot();
            return ({
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    { type: "text", text: `Screen is ${shot.width}x${shot.height} px.` },
                ],
            } as any);
        },
    );

    server.registerTool(
        "move_mouse",
        { description: "Move the mouse to a pixel coordinate on the current frame.", inputSchema: { x: z.number(), y: z.number() } },
        async ({ x, y }): Promise<any> => {
            const g = await gate("move_mouse", { x, y });
            if (!g.ok) return blocked(g.why);
            await deps.control.moveMouse(x, y);
            return ok(`Moved to (${x}, ${y}).`);
        },
    );

    const clickShape = {
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
    };
    server.registerTool(
        "click",
        { description: "Click, optionally moving to (x, y) first.", inputSchema: clickShape },
        async ({ x, y, button }): Promise<any> => {
            const g = await gate("click", { x, y, button });
            if (!g.ok) return blocked(g.why);
            if (typeof x === "number" && typeof y === "number") await deps.control.moveMouse(x, y);
            await deps.control.click((button as MouseButton) ?? "left");
            return ok("Clicked.");
        },
    );

    server.registerTool(
        "double_click",
        { description: "Double-click, optionally moving to (x, y) first.", inputSchema: clickShape },
        async ({ x, y, button }): Promise<any> => {
            const g = await gate("double_click", { x, y, button });
            if (!g.ok) return blocked(g.why);
            if (typeof x === "number" && typeof y === "number") await deps.control.moveMouse(x, y);
            await deps.control.doubleClick((button as MouseButton) ?? "left");
            return ok("Double-clicked.");
        },
    );

    server.registerTool(
        "type_text",
        {
            description: "Type text with humanlike timing and self-correction. Final text matches exactly.",
            inputSchema: { text: z.string(), code: z.boolean().optional() },
        },
        async ({ text, code }): Promise<any> => {
            const g = await gate("type_text", { text, code });
            if (!g.ok) return blocked(g.why);
            await deps.control.typeText(text, typeof code === "boolean" ? { code } : {});
            return ok(`Typed ${text.length} characters.`);
        },
    );

    server.registerTool(
        "press_key",
        { description: 'Press a single key by JS event.code (e.g. "Enter", "Tab").', inputSchema: { key: z.string() } },
        async ({ key }): Promise<any> => {
            const g = await gate("press_key", { key });
            if (!g.ok) return blocked(g.why);
            await deps.control.pressKey(key);
            return ok(`Pressed ${key}.`);
        },
    );

    server.registerTool(
        "hotkey",
        { description: 'Press a chord, e.g. ["ControlLeft","KeyC"].', inputSchema: { codes: z.array(z.string()) } },
        async ({ codes }): Promise<any> => {
            const g = await gate("hotkey", { codes });
            if (!g.ok) return blocked(g.why);
            await deps.control.hotkey(codes);
            return ok(`Pressed ${codes.join("+")}.`);
        },
    );

    server.registerTool(
        "scroll",
        { description: "Scroll the wheel. dy positive = up.", inputSchema: { dx: z.number().optional(), dy: z.number().optional() } },
        async ({ dx, dy }): Promise<any> => {
            const g = await gate("scroll", { dx, dy });
            if (!g.ok) return blocked(g.why);
            await deps.control.scroll(dx ?? 0, dy ?? 0);
            return ok(`Scrolled (${dx ?? 0}, ${dy ?? 0}).`);
        },
    );

    return server;
}

/**
 * Build a Streamable-HTTP request handler for the MCP server. Stateless
 * (sessionIdGenerator undefined) so each request stands alone — simplest for a
 * single local client.
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
