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
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

// Per-request session id (from the /mcp/<id> path), threaded to the tool handlers so the
// KVM control lease can be enforced for agents (codex/opencode) that have no permission hook.
const sessionCtx = new AsyncLocalStorage<{ session: string | undefined }>();
import type { IncomingMessage, ServerResponse } from "http";
import { isAltTabPeekHotkey, type PiKvmControl, type MouseButton } from "./pikvm-control";
import type { OperationReviewer } from "./reviewer";
import type { PresenceMonitor } from "./presence";
import type { SecretsStore } from "./secrets";
import type { RegionsResult } from "./agent/regions";
import { runWatchedTyping, visibleTypingRegionIssue, type Region as TypingRegion, type WatchedTypingDeps } from "./agent/watched-typing";

export interface McpDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    /** Named credential vault — Claude Code can type secrets it never sees. */
    secrets: SecretsStore;
    /** Cached, change-gated screen-region map (labelled UI areas with boxes). */
    getRegions: () => RegionsResult | null;
    /** Called after a full-frame screenshot so callers outside the runner still refresh regions. */
    onFullScreenshot?: () => void;
    /** Fast local OCR read-back for watched typing (vision confirms a mismatch). */
    opticalRead?: (image: { data: string; mimeType: string }) => Promise<string>;
    opticalReadStrong?: (image: { data: string; mimeType: string }) => Promise<string>;
    /** Persist a learned fact (e.g. the target's keyboard layout). */
    remember?: (text: string) => void;
    /** KVM control lease: acquire/affirm for a hands action; ok:false if another session
     *  holds it. Enforced here for agents without a Claude-style hook (codex/opencode). */
    acquireKvmControl?: (session: string | undefined) => { ok: boolean; reason?: string };
    /** Refresh the holder's lease on read-only activity, so an agent looking/thinking
     *  between actions doesn't lapse into the abandonment backstop and lose control. */
    touchKvmControl?: (session: string | undefined) => void;
    /** Full guardrail assessment (dangerous-command + sensitive-area + lease) for a hands op
     *  from a hook-less agent (codex/opencode). Claude gets this via its PreToolUse hook; for
     *  the others the MCP server runs it so dangerous ops are detected + hard-denied too. */
    assessOp?: (tool: string, args: Record<string, unknown>, session: string) => Promise<{ decision: "allow" | "ask" | "deny"; reason?: string }>;
    /** High-quality document "scanner" — scrolls + stitches + OCRs a long document open on
     *  the target into a transcript + page images/PDF (the vendored tools/doc-capture). Absent
     *  if not wired (e.g. python/deps unavailable). */
    captureDocument?: (opts: { mode?: "scan" | "paged"; onProgress?: (line: string) => void }) => Promise<{
        ok: boolean;
        transcript?: string;
        outDir: string;
        pdfPath?: string;
        pageCount?: number;
        error?: string;
    }>;
}

// Tools that move the mouse / type — the ones that need the dangerous-op guardrail.
const HANDS_TOOLS = new Set(["move_mouse", "click", "double_click", "drag", "type_text", "type_text_at", "paste_text", "type_secret", "press_key", "hotkey", "scroll"]);

const region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export function createMcpServer(deps: McpDeps): McpServer {
    const server = new McpServer(
        { name: "pikvm", version: "2.0.0" },
        {
            instructions:
                "Drive a real computer through PiKVM. ALWAYS screenshot first; coordinates are full-frame pixels (the screenshot text states the exact WxH). " +
                "Every action tool (click, type_text, press_key, scroll, drag, …) NOW RETURNS THE POST-ACTION SCREENSHOT as its result — you do NOT need a separate screenshot() after acting; read the returned image to confirm the effect before the next step. " +
                "Freshness is enforced: if the screen changed underneath you since your last look (a popup, a call, a window opening), the tool will REFUSE the action and hand you the current screen prefixed '⚠️ Did NOT …' — re-read THAT screen and re-issue. Do not fight it; acknowledge the new window/dialog first. " +
                "If a result includes '🔔 Watched region changed', a region you asked to monitor (watch_region) changed — look before assuming. Use watch_region to keep an eye on something loading (a VM/app/build) while you work elsewhere. " +
                "Use ocr to read text, zoom to read small text, get_regions to know where windows/taskbars/terminals are. type_text is watched + " +
                "self-correcting and NEVER presses Enter (use press_key('Enter') to submit). Use type_secret for passwords. " +
                "You are driving a FULL GUI desktop — prefer GUI apps over the terminal for tasks they do better: to READ or EDIT a file, open it in the editor/IDE (e.g. VS Code: Ctrl+P then the path, or open from Explorer) rather than cat/sed/less in a terminal (cleaner, scrolls, no prompt noise); the terminal is for running commands. " +
                "When you DO read a field/terminal back, ignore a leading shell prompt ('$ ', 'user@host…$') — it isn't text you typed. " +
                "Alt+Tab is special: hotkey(['AltLeft','Tab']) keeps Alt held so the switcher remains visible; immediately screenshot/ocr/get_regions, which releases it after the look. " +
                "Risky/sensitive actions will ask for your approval in this terminal. " +
                "Workplace defaults: email is Microsoft Outlook/Microsoft 365, chat is Microsoft Teams. Do not use Gmail or " +
                "a Gmail connector unless the user explicitly says Gmail; for email/messages use the PiKVM screen and Outlook/Teams.",
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
        printText: (t) => deps.control.printText(t),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        capsLockOn: () => deps.control.getCapsLock(),
    });

    // Gate for every hands action: wait out presence (DND), then enforce the single-controller
    // KVM lease for the calling session (codex/opencode have no permission hook, so this is
    // their guardrail; for Claude the hook also enforces it — belt and suspenders).
    const yieldToPresence = async (): Promise<void> => {
        await deps.presence.waitUntilAllowed();
        const lease = deps.acquireKvmControl?.(sessionCtx.getStore()?.session);
        if (lease && !lease.ok) throw new Error(lease.reason || "Another agent session is controlling the KVM.");
        // Don't act into a detached HID — keystrokes/clicks would silently vanish and the
        // agent would then "verify" against an unchanged screen and loop. Only block on an
        // EXPLICIT detached signal from KVMD; unknown (undefined) means allow.
        if (deps.control.isHidOnline?.() === false) {
            throw new Error("Target HID is not attached — input would be lost. Check the PiKVM's USB/HID connection to the target, then retry.");
        }
    };
    // Read-only tools call this so the holder keeps control while it looks/thinks.
    const touchLease = () => deps.touchKvmControl?.(sessionCtx.getStore()?.session);
    const ok = (text: string): any => ({ content: [{ type: "text", text }] });
    // Clamp a coordinate into the current frame and note any correction, so a vision
    // overshoot lands a near-hit (and the model learns its estimate was off) instead
    // of an off-screen no-op with no feedback.
    const clampPt = (x: number, y: number): { x: number; y: number; note: string } => {
        const d = deps.control.getDimensions();
        const cx = Math.max(0, Math.min(Math.round(x), Math.max(0, d.width - 1)));
        const cy = Math.max(0, Math.min(Math.round(y), Math.max(0, d.height - 1)));
        const note = cx !== Math.round(x) || cy !== Math.round(y) ? ` (clamped to ${cx},${cy}; frame is ${d.width}x${d.height})` : "";
        return { x: cx, y: cy, note };
    };
    // Hold a modifier (shift/ctrl/alt/super) down across a mouse action — range/multi-
    // select, horizontal scroll — then always release it.
    const MODIFIER_CODE: Record<string, string> = { shift: "ShiftLeft", ctrl: "ControlLeft", alt: "AltLeft", super: "MetaLeft" };
    const withModifier = async <T>(modifier: string | undefined, action: () => Promise<T>): Promise<T> => {
        const code = modifier ? MODIFIER_CODE[modifier] : undefined;
        if (!code) return action();
        await deps.control.keyDown(code);
        try {
            return await action();
        } finally {
            await deps.control.keyUp(code).catch(() => {});
        }
    };
    const releaseHeldAfterLook = async () =>
        (await deps.control.releaseHeldHotkeys("after look").catch(() => false)) ? "\nReleased held Alt+Tab after this look." : "";

    // --- Screen-freshness enforcement (build on the perceptual fingerprint + grid) ---
    // The agent (Claude Code) can only see the screen via tool results, so we make the
    // tools self-policing: BEFORE an action we check whether the screen changed under it
    // since it last saw the full frame (an async popup / call / window) and, if so,
    // refuse + hand back the current screen; AFTER an action we settle + return the
    // post-action screen. So the agent never acts on, or fails to notice, a stale view.
    const watchNote = (): string => {
        // The BACKGROUND monitor detects watched-region changes and enqueues notices; we
        // just drain them onto the next tool result so the agent learns in-band.
        const notices = deps.control.drainWatchNotices?.() ?? [];
        return notices.length ? `\n🔔 Watched region(s) changed: ${notices.join(", ")} — look before assuming.` : "";
    };
    const lookResult = async (label: string): Promise<any> => {
        const shot = await deps.control.screenshot();
        const note = watchNote();
        await deps.control.markAgentLook?.();
        deps.onFullScreenshot?.();
        return {
            content: [
                { type: "image", data: shot.base64, mimeType: shot.mimeType },
                { type: "text", text: `${label} Screen is ${shot.width}x${shot.height} px.${note}` },
            ],
        };
    };
    // Returns a fresh-screenshot result when the screen is stale (agent must re-look),
    // else null to proceed with the action.
    const staleGuard = async (action: string): Promise<any | null> => {
        const f = await deps.control.lookFreshness?.();
        if (!f || !f.changed) return null;
        const ago = Number.isFinite(f.ageMs) ? `, ${Math.round(f.ageMs / 1000)}s since your last look` : "";
        const why = f.hasBaseline
            ? `the screen CHANGED since your last screenshot${f.delta != null ? ` (Δ${Math.round(f.delta * 100)}%)` : ""}${ago}`
            : `you haven't taken a screenshot yet`;
        return lookResult(`⚠️ Did NOT ${action} — ${why}. A window/dialog may have opened over your target. Re-read THIS current screen, then re-issue the action.`);
    };
    // Settle, then return the post-action screenshot as the result.
    const actionResult = async (summary: string): Promise<any> => {
        await deps.control.waitUntilSettled?.().catch(() => undefined);
        return lookResult(summary);
    };
    const hotkeyMessage = (codes: string[]) =>
        isAltTabPeekHotkey(codes)
            ? "Alt+Tab switcher is open. Alt is being held so screenshot/ocr/get_regions can inspect all open apps; it will release after that look, or before the next mouse/keyboard action."
            : `Pressed ${codes.join("+")}.`;

    server.registerTool(
        "screenshot",
        {
            description: "Capture the current target screen as a JPEG, optionally cropped to a region to zoom in. Call before and after actions.",
            inputSchema: { region: region.optional() },
        },
        async ({ region: r }): Promise<any> => {
            touchLease();
            let shot: Awaited<ReturnType<PiKvmControl["screenshot"]>>;
            try {
                shot = await deps.control.screenshot(r);
            } catch (e) {
                await releaseHeldAfterLook();
                throw e;
            }
            let watch = "";
            if (!r) {
                deps.onFullScreenshot?.();
                watch = watchNote();
                await deps.control.markAgentLook?.(); // a full-frame look refreshes the freshness baseline
            }
            const releaseNote = await releaseHeldAfterLook();
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    { type: "text", text: `${r ? `Cropped region ${shot.width}x${shot.height} px.` : `Screen is ${shot.width}x${shot.height} px.`}${watch}${releaseNote}` },
                ],
            } as any;
        },
    );

    server.registerTool(
        "ocr",
        { description: "Read on-screen text via the target's built-in OCR, optionally within a region. Faster/cheaper than reading a screenshot for plain text.", inputSchema: { region: region.optional() } },
        async ({ region: r }): Promise<any> => {
            touchLease();
            let out: string;
            try {
                out = await deps.control.ocr(r);
            } catch (e) {
                await releaseHeldAfterLook();
                throw e;
            }
            const releaseNote = await releaseHeldAfterLook();
            return ok(`${out.trim() ? out : "(no text found)"}${releaseNote}`);
        },
    );

    server.registerTool(
        "get_regions",
        { description: "List the salient UI regions of the current screen — label, kind (taskbar/window/terminal/browser/emulator/panel/dialog/menu), and a full-frame bounding box. Use it to know WHERE you are and to find a window before clicking/cropping.", inputSchema: {} },
        async (): Promise<any> => {
            touchLease();
            const res = deps.getRegions();
            const releaseNote = await releaseHeldAfterLook();
            if (!res || !res.regions.length) return ok(`No screen regions available yet — take a screenshot first, then try again.${releaseNote}`);
            const lines = res.regions.map((r) => `• ${r.label} [${r.kind}] — x=${r.bbox.x}, y=${r.bbox.y}, ${r.bbox.width}x${r.bbox.height}`);
            return ok(`Screen regions (frame ${res.width}x${res.height} px, origin top-left):\n${lines.join("\n")}${releaseNote}`);
        },
    );

    server.registerTool(
        "move_mouse",
        { description: "Move the mouse to a pixel coordinate on the current frame.", inputSchema: { x: z.number(), y: z.number() } },
        async ({ x, y }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard("move the mouse");
            if (stale) return stale;
            const p = clampPt(x, y);
            await deps.control.moveMouse(p.x, p.y);
            return actionResult(`Moved to (${p.x}, ${p.y}).${p.note}`);
        },
    );

    const modifierField = z.enum(["shift", "ctrl", "alt", "super"]).optional();
    const clickShape = { x: z.number().optional(), y: z.number().optional(), button: z.enum(["left", "right", "middle"]).optional(), modifier: modifierField };
    server.registerTool(
        "click",
        { description: "Click, optionally moving to (x, y) first. Pass modifier ('shift'|'ctrl'|'alt'|'super') to hold it during the click — e.g. shift-click to range-select, ctrl-click to multi-select.", inputSchema: clickShape },
        async ({ x, y, button, modifier }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard(typeof x === "number" ? `click at (${x}, ${y})` : "click");
            if (stale) return stale;
            let note = "";
            if (typeof x === "number" && typeof y === "number") {
                const p = clampPt(x, y);
                note = p.note;
                await deps.control.moveMouse(p.x, p.y);
            }
            await withModifier(modifier, () => deps.control.click((button as MouseButton) ?? "left"));
            return actionResult(`Clicked${modifier ? ` (${modifier}-held)` : ""}.${note}`);
        },
    );

    server.registerTool(
        "double_click",
        { description: "Double-click, optionally moving to (x, y) first. Optional modifier is held during the click.", inputSchema: clickShape },
        async ({ x, y, button, modifier }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard(typeof x === "number" ? `double-click at (${x}, ${y})` : "double-click");
            if (stale) return stale;
            let note = "";
            if (typeof x === "number" && typeof y === "number") {
                const p = clampPt(x, y);
                note = p.note;
                await deps.control.moveMouse(p.x, p.y);
            }
            await withModifier(modifier, () => deps.control.doubleClick((button as MouseButton) ?? "left"));
            return actionResult(`Double-clicked${modifier ? ` (${modifier}-held)` : ""}.${note}`);
        },
    );

    server.registerTool(
        "drag",
        { description: "Drag from (fromX, fromY) to (toX, toY) holding a mouse button — for sliders, selections, drag-and-drop.", inputSchema: { fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), button: z.enum(["left", "right", "middle"]).optional() } },
        async ({ fromX, fromY, toX, toY, button }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard("drag");
            if (stale) return stale;
            const a = clampPt(fromX, fromY);
            const b = clampPt(toX, toY);
            await deps.control.drag({ x: a.x, y: a.y }, { x: b.x, y: b.y }, (button as MouseButton) ?? "left");
            return actionResult(`Dragged (${a.x},${a.y}) → (${b.x},${b.y}).${a.note}${b.note}`);
        },
    );

    server.registerTool(
        "type_text",
        {
            description: "Type text into the focused, VISIBLE field — WATCHED + self-correcting (tracks the field's changing pixels, reads it back, fixes layout slips). BEFORE calling: screenshot/get_regions, confirm the target text box/text area/terminal input line is visible on screen, click/focus it, then pass its visible box as verify_region. NEVER presses Enter (newlines collapse to spaces); use press_key('Enter') to submit. If it reports the field isn't focused, STOP retrying type_text: screenshot/get_regions, click inside the target field or otherwise focus it, verify the caret/focus, then call type_text once.",
            inputSchema: { text: z.string(), code: z.boolean().optional(), verify_region: region.optional() },
        },
        async ({ text, code, verify_region }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard("type text"); // don't type into a field a popup may have covered
            if (stale) return stale;
            const regionIssue = visibleTypingRegionIssue(verify_region as TypingRegion | undefined, deps.control.getDimensions());
            if (regionIssue) return ok(regionIssue);
            const intended = String(text).replace(/[\r\n]+/g, " ");
            const res = await runWatchedTyping(
                intended,
                { ...(typeof code === "boolean" ? { code } : {}), ...(verify_region ? { verifyRegion: verify_region as TypingRegion } : {}) },
                watchedTypingDeps(),
            );
            let out = res.summary;
            if (res.readBack) out += `\nIntended: "${intended}"\nField reads: "${res.readBack}"`;
            return actionResult(out);
        },
    );

    server.registerTool(
        "press_key",
        { description: 'Press a single key by JS event.code (e.g. "Enter", "Tab", "ArrowDown"). This is how you submit (Enter).', inputSchema: { key: z.string() } },
        async ({ key }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard(`press ${key}`);
            if (stale) return stale;
            await deps.control.pressKey(key);
            return actionResult(`Pressed ${key}.`);
        },
    );

    server.registerTool(
        "hotkey",
        { description: 'Press a chord, e.g. ["ControlLeft","KeyC"] for Ctrl+C. Alt+Tab is a peek chord: Alt stays held so you can screenshot/ocr/get_regions the app switcher, then releases after that look.', inputSchema: { codes: z.array(z.string()) } },
        async ({ codes }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard(`press ${codes.join("+")}`);
            if (stale) return stale;
            await deps.control.hotkey(codes);
            // Keep the text result (don't auto-screenshot) so the Alt+Tab peek can hold Alt
            // across the agent's own follow-up screenshot/get_regions look.
            return ok(hotkeyMessage(codes));
        },
    );

    server.registerTool(
        "scroll",
        {
            description:
                "Scroll the wheel. EASIEST: pass direction ('up'|'down'|'left'|'right') + amount (notches, default 3) — e.g. scroll up a terminal's history with direction:'up', amount:5. (You can also pass raw dx/dy where dy positive = up.) Pass x,y to move there first so the intended pane scrolls (a multi-pane desktop scrolls under the cursor). modifier 'shift' scrolls horizontally on most apps.",
            inputSchema: {
                direction: z.enum(["up", "down", "left", "right"]).optional(),
                amount: z.coerce.number().optional(),
                dx: z.number().optional(),
                dy: z.number().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
                modifier: modifierField,
            },
        },
        async ({ direction, amount, dx, dy, x, y, modifier }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard("scroll");
            if (stale) return stale;
            let note = "";
            if (typeof x === "number" && typeof y === "number") {
                const p = clampPt(x, y);
                note = p.note;
                await deps.control.moveMouse(p.x, p.y);
            }
            // direction + amount → wheel deltas (our convention: dy>0 = up, dx>0 = right).
            let sdx = dx ?? 0;
            let sdy = dy ?? 0;
            if (direction) {
                const n = Math.max(1, Math.abs(amount ?? 3));
                if (direction === "up") sdy = n;
                else if (direction === "down") sdy = -n;
                else if (direction === "right") sdx = n;
                else if (direction === "left") sdx = -n;
            }
            if (sdx === 0 && sdy === 0) sdy = 3; // a bare scroll() means "scroll down a bit", never a silent no-op
            await withModifier(modifier, () => deps.control.scroll(sdx, sdy));
            return actionResult(`Scrolled (${sdx}, ${sdy})${direction ? ` [${direction}]` : ""}${modifier ? ` (${modifier}-held)` : ""}.${note}`);
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
        {
            description: "Type a saved secret (e.g. a password) into the focused, VISIBLE field WITHOUT seeing its value. BEFORE calling: screenshot/get_regions, confirm the password/secret field is visible on screen, click/focus it, then pass its visible box as verify_region. The value never enters your context. Press Enter / click separately if needed.",
            inputSchema: { name: z.string(), verify_region: region.optional() },
        },
        async ({ name, verify_region }): Promise<any> => {
            await yieldToPresence();
            const value = deps.secrets.get(name);
            if (value == null) {
                const names = deps.secrets.names();
                return ok(`No secret named "${name}". Available: ${names.length ? names.join(", ") : "(none)"}.`);
            }
            const stale = await staleGuard("type the secret");
            if (stale) return stale;
            const regionIssue = visibleTypingRegionIssue(verify_region as TypingRegion | undefined, deps.control.getDimensions());
            if (regionIssue) return ok(regionIssue);
            await deps.control.typeText(value, { intensity: 0, secret: true });
            return actionResult(`Typed the secret "${name}" (${value.length} chars, value hidden).`);
        },
    );

    server.registerTool(
        "zoom",
        {
            description:
                "Zoom in: capture a region of the current frame at FULL native resolution to read small text — filenames, tab titles, status bars, line numbers, button labels — or to confirm a control before clicking. Faster than ocr. READ-ONLY: clicks still use full-frame pixel coordinates; do NOT click using a zoomed crop's coordinates.",
            inputSchema: { region },
        },
        async ({ region: r }): Promise<any> => {
            touchLease();
            const shot = await deps.control.screenshot(r);
            return {
                content: [
                    { type: "image", data: shot.base64, mimeType: shot.mimeType },
                    { type: "text", text: `Zoomed ${shot.width}x${shot.height} px (full-res crop). Click using full-frame coordinates, not crop-local ones.` },
                ],
            } as any;
        },
    );

    server.registerTool(
        "wait",
        { description: "Pause briefly for a UI animation/load before you act or look. ms is capped at 5000 (default 800).", inputSchema: { ms: z.number().optional() } },
        async ({ ms }): Promise<any> => {
            touchLease();
            const d = Math.max(0, Math.min(5000, Math.round(ms ?? 800)));
            await new Promise((res) => setTimeout(res, d));
            return ok(`Waited ${d}ms.`);
        },
    );

    server.registerTool(
        "wait_until_settled",
        {
            description:
                "Wait until the screen STOPS changing (a load/animation/transition finishes) before you act or read — more precise than a fixed wait. Returns once settled or at the timeout.",
            inputSchema: { timeout_ms: z.number().optional() },
        },
        async ({ timeout_ms }): Promise<any> => {
            touchLease();
            const res = await deps.control.waitUntilSettled(
                typeof timeout_ms === "number" ? { timeoutMs: Math.max(200, Math.min(10000, Math.round(timeout_ms))) } : {},
            );
            return ok(
                res.ready && !res.stillAnimating
                    ? `Screen settled after ${res.waitedMs}ms.`
                    : `Screen still changing after ${res.waitedMs}ms — gave up (likely an animation/spinner); proceed and re-check.`,
            );
        },
    );

    server.registerTool(
        "type_text_at",
        {
            description:
                "Focus a field at (x, y) and type into it in ONE call — clicks to focus, then watched/self-correcting typing that locates the field from the changing pixels. Saves the screenshot→click→type round-trip. NEVER submits: typing can't press Enter (use press_key('Enter') deliberately afterwards). Pass code:true for commands/code.",
            inputSchema: { x: z.number(), y: z.number(), text: z.string(), code: z.boolean().optional() },
        },
        async ({ x, y, text, code }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard(`focus + type at (${x}, ${y})`);
            if (stale) return stale;
            const p = clampPt(x, y);
            await deps.control.moveMouse(p.x, p.y);
            await deps.control.click("left"); // focus the field
            const intended = String(text).replace(/[\r\n]+/g, " ");
            const res = await runWatchedTyping(intended, { ...(typeof code === "boolean" ? { code } : {}) }, watchedTypingDeps());
            let out = `Focused (${p.x},${p.y}) and ${res.summary}${p.note}`;
            if (res.readBack) out += `\nIntended: "${intended}"\nField reads: "${res.readBack}"`;
            return actionResult(out);
        },
    );

    server.registerTool(
        "paste_text",
        {
            description:
                "Enter a MULTI-LINE block of text into the focused field FAST — for a composed chat message, email body, or any long/multi-paragraph text. Types each line server-side via the keymap printer (far faster + more reliable than char-by-char) and inserts line breaks DELIBERATELY: Shift+Enter by default (never submits) or a real Enter (line_break:'enter') — use 'enter' ONLY where Enter is a newline (an editor, or a chat box already in 'Enter = new line' mode); a real Enter in a normal chat box SENDS. It NEVER presses a trailing Enter, so it can't send. BEFORE calling: screenshot/get_regions, click/focus the field, pass its visible box as verify_region. Returns the post-paste screenshot — confirm it landed before sending. " +
                "TEAMS NOTE: with the default Shift+Enter, Teams often bullets only the FIRST '- ' line and leaves the rest literal. For proper bullets, FIRST open the expanded composer (hotkey ControlLeft+ShiftLeft+KeyX), screenshot to confirm it opened, THEN paste with line_break:'enter'. To SEND a Teams message use hotkey(['ControlLeft','Enter']) (Ctrl+Enter — works regardless of the Enter=send/new-line setting), not a bare Enter.",
            inputSchema: { text: z.string(), verify_region: region.optional(), line_break: z.enum(["shift_enter", "enter"]).optional() },
        },
        async ({ text, verify_region, line_break }): Promise<any> => {
            await yieldToPresence();
            const stale = await staleGuard("paste text");
            if (stale) return stale;
            const regionIssue = visibleTypingRegionIssue(verify_region as TypingRegion | undefined, deps.control.getDimensions());
            if (regionIssue) return ok(regionIssue);
            const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
            const breakKey =
                line_break === "enter"
                    ? () => deps.control.pressKey("Enter")
                    : () => deps.control.hotkey(["ShiftLeft", "Enter"]); // chat-safe newline; never submits
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? "";
                if (line) await deps.control.printText(line);
                if (i < lines.length - 1) await breakKey();
            }
            return actionResult(`Pasted ${lines.length} line(s) (${text.length} chars; ${line_break === "enter" ? "Enter" : "Shift+Enter"} breaks, no trailing submit).`);
        },
    );

    server.registerTool(
        "watch_region",
        {
            description:
                "Monitor a screen region for change while you do other things — e.g. an app/VM that's launching, a build/progress area, a status indicator. After this, screenshots and action results announce '🔔 Watched region changed' when that area changes (a window finishing loading, a dialog appearing). Pass a short label and the region's full-frame box. Re-call with the same label to reset its baseline.",
            inputSchema: { label: z.string(), region },
        },
        async ({ label, region: r }): Promise<any> => {
            touchLease();
            const okSet = await deps.control.watchRegion?.(label, r as { x: number; y: number; width: number; height: number });
            return ok(okSet ? `Watching region "${label}" (${r.width}x${r.height} at ${r.x},${r.y}). I'll flag it when it changes.` : `Couldn't start the watch (no live frame yet) — take a screenshot first, then retry.`);
        },
    );

    server.registerTool(
        "unwatch_region",
        { description: "Stop monitoring a region previously set with watch_region (pass the same label), or omit label semantics by passing it. Use list via the note on results.", inputSchema: { label: z.string() } },
        async ({ label }): Promise<any> => {
            touchLease();
            const removed = deps.control.unwatchRegion?.(label);
            const left = deps.control.listWatches?.() ?? [];
            return ok(`${removed ? `Stopped watching "${label}".` : `No active watch named "${label}".`}${left.length ? ` Still watching: ${left.join(", ")}.` : ""}`);
        },
    );

    if (deps.captureDocument) {
        const capture = deps.captureDocument;
        server.registerTool(
            "capture_document",
            {
                description:
                    "HIGH-QUALITY document scanner for a long document open on the target (e.g. a Word .docx). It scrolls the document top-to-bottom, captures native-resolution frames, stitches them, splits into pages and runs OCR — FAR sharper text + figures than a single screenshot, ideal for pulling a whole document into your context or saving it to the knowledge base (Atlas). " +
                    "PREP THE DOCUMENT FIRST (use your other tools): open it, switch to a LIGHT theme, auto-hide the ribbon / go full-screen, set zoom to 'Page Width', enable Do Not Disturb (no toast popups), click into the document and press Ctrl+Home to put the caret at the very top. " +
                    "Then call this. It runs for a minute or two (it drives the scroll itself) and returns the OCR transcript plus the paths to the saved page images and searchable PDF.",
                inputSchema: { mode: z.enum(["scan", "paged"]).optional() },
            },
            async ({ mode }): Promise<any> => {
                await yieldToPresence();
                const res = await capture(mode ? { mode } : {});
                if (!res.ok) return ok(`Document capture failed: ${res.error ?? "unknown error"}`);
                const tx = res.transcript ?? "";
                const MAX = 16000;
                const body = tx.length > MAX ? `${tx.slice(0, MAX)}\n…(transcript truncated; ${tx.length} chars total — full text at ${res.outDir}/all.txt)` : tx || "(no transcript produced — check the page images)";
                let out = `Captured ${res.pageCount ?? "?"} page(s) → ${res.outDir}`;
                if (res.pdfPath) out += `\nSearchable PDF: ${res.pdfPath}`;
                out += `\n\n--- OCR transcript ---\n${body}`;
                return ok(out);
            },
        );
    }

    return server;
}

/**
 * Build a Streamable-HTTP request handler for the MCP server. Stateless
 * (sessionIdGenerator undefined) so each request stands alone — simplest for a
 * single local client (Claude Code in the embedded terminal).
 */
export function createMcpHttpHandler(deps: McpDeps) {
    return async (req: IncomingMessage, res: ServerResponse, body: unknown, session?: string): Promise<void> => {
        // Guardrail for hook-less agents (codex/opencode reach us at /mcp/<session>): run the
        // full dangerous-command + sensitive-area assessment on a hands tools/call and
        // hard-deny "deny" verdicts before the tool runs. Claude uses /mcp (no session) and is
        // gated by its PreToolUse hook instead, so it skips this path.
        if (session && deps.assessOp && body && typeof body === "object" && !Array.isArray(body)) {
            const b = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
            if (b.method === "tools/call" && b.params?.name && HANDS_TOOLS.has(b.params.name)) {
                try {
                    const v = await deps.assessOp(b.params.name, b.params.arguments ?? {}, session);
                    if (v.decision === "deny") {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id ?? null, result: { content: [{ type: "text", text: v.reason || "Blocked by the PiKVM guardrail." }], isError: true } }));
                        return;
                    }
                } catch {
                    /* assessment failure must not block a legitimate op — fall through */
                }
            }
        }
        const server = createMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport as any);
        // Run inside the session context so the tool gate can read the calling session id.
        await sessionCtx.run({ session }, () => transport.handleRequest(req, res, body));
    };
}
