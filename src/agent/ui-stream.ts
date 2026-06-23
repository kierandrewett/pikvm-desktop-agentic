/**
 * Bridges Pi `AgentEvent`s onto the Vercel AI SDK UI message stream that the
 * sidebar's `useChat` consumes. Text deltas become text parts; tool lifecycle
 * becomes tool parts; screenshots become custom `data-screenshot` parts so the
 * UI can show thumbnails.
 */

import type { UIMessageStreamWriter } from "ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { PiKvmUIMessage } from "./protocol";

type Writer = UIMessageStreamWriter<PiKvmUIMessage>;

/** Pull an image (base64 jpeg/png) out of a tool result's content array. */
function imageFrom(result: any): { data: string; mimeType: string } | undefined {
    const content = result?.content;
    if (!Array.isArray(content)) return undefined;
    const img = content.find((c: any) => c?.type === "image" && c.data);
    return img ? { data: img.data, mimeType: img.mimeType ?? "image/jpeg" } : undefined;
}

function textFrom(result: any): string {
    const content = result?.content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join(" ");
}

/** Turn a raw model/provider error into a short, honest, actionable line. */
export function friendlyAgentError(raw: string): string {
    const r = raw.toLowerCase();
    if (r.includes("overload") || r.includes("server_is_overloaded") || r.includes("service_unavailable") || /\b503\b/.test(r))
        return "⚠️ The model provider is overloaded right now — your task didn't run. It’ll auto-retry; if it keeps failing, send again in a moment.";
    if (r.includes("rate") && r.includes("limit"))
        return "⚠️ Rate-limited by the model provider — your task didn't run. It’ll auto-retry shortly.";
    if (r.includes("timeout") || r.includes("timed out") || r.includes("etimedout"))
        return "⚠️ The model provider timed out — your task didn't run. It’ll auto-retry; send again if it persists.";
    if (r.includes("401") || r.includes("unauthor") || r.includes("invalid api key") || r.includes("authentication"))
        return "⚠️ The model provider rejected the credentials — check the API key/login in Settings → Providers.";
    if (r.includes("insufficient") || r.includes("quota") || r.includes("billing") || r.includes("payment"))
        return "⚠️ The model provider reports no remaining quota/credit — check billing for the provider.";
    // Fall back to the raw message (trimmed) so the user still sees SOMETHING, not silence.
    const short = raw.replace(/\s+/g, " ").trim().slice(0, 240);
    return `⚠️ The model provider returned an error — your task didn't run${short ? `: ${short}` : "."}`;
}

/**
 * Wire a writer to an agent-event stream. Returns a listener to pass to
 * `runner.subscribe(...)`. The caller is responsible for resolving the
 * surrounding promise on `agent_end`.
 */
export function bridgeAgentEvents(writer: Writer): (event: AgentEvent) => void {
    const startedText = new Set<string>();
    let textCounter = 0;
    let currentTextId: string | undefined;
    let thinkId: string | undefined;
    let thinkText = "";
    let lastScreenshotId: string | undefined;

    const endText = () => {
        if (currentTextId && startedText.has(currentTextId)) {
            writer.write({ type: "text-end", id: currentTextId });
            startedText.delete(currentTextId);
        }
        currentTextId = undefined;
    };

    return (event: AgentEvent) => {
        switch (event.type) {
            case "message_update": {
                const e: any = (event as any).assistantMessageEvent;
                if (!e) return;
                // Reasoning / "thinking" stream → a collapsible data part.
                if (e.type === "thinking_start") {
                    thinkId = `think-${textCounter++}`;
                    thinkText = "";
                    writer.write({ type: "data-thinking", id: thinkId, data: { id: thinkId, text: "" } });
                    return;
                }
                if (e.type === "thinking_delta") {
                    if (!thinkId) {
                        thinkId = `think-${textCounter++}`;
                        thinkText = "";
                    }
                    thinkText += e.delta ?? "";
                    writer.write({ type: "data-thinking", id: thinkId, data: { id: thinkId, text: thinkText } });
                    return;
                }
                if (e.type === "thinking_end") {
                    if (thinkId)
                        writer.write({ type: "data-thinking", id: thinkId, data: { id: thinkId, text: thinkText, done: true } });
                    thinkId = undefined;
                    return;
                }
                if (e.type === "text_start") {
                    const id = `t${textCounter++}`;
                    currentTextId = id;
                    startedText.add(id);
                    writer.write({ type: "text-start", id });
                } else if (e.type === "text_delta") {
                    if (!currentTextId) {
                        const id = `t${textCounter++}`;
                        currentTextId = id;
                        startedText.add(id);
                        writer.write({ type: "text-start", id });
                    }
                    writer.write({ type: "text-delta", id: currentTextId, delta: e.delta ?? "" });
                } else if (e.type === "text_end") {
                    endText();
                }
                return;
            }
            case "message_end": {
                // A turn that ended in an error (most commonly a provider 503 / overload /
                // rate-limit) MUST be shown — otherwise the run just goes "idle" and looks
                // like the agent gave up. Surface a plain-English status into the transcript.
                endText();
                // Close out any dangling thinking stream so the NEXT run (this hub bridge is
                // long-lived) can't append onto stale reasoning text.
                thinkId = undefined;
                thinkText = "";
                const m: any = (event as any).message;
                if (m?.stopReason === "error") {
                    writer.write({ type: "data-status", data: { kind: "info", text: friendlyAgentError(String(m.errorMessage ?? "")) } });
                }
                return;
            }
            case "agent_start": {
                // Fresh run on a long-lived bridge → drop any per-run carry-over so a new
                // run's first marker/thinking can't bind to the previous run's screenshot.
                endText();
                thinkId = undefined;
                thinkText = "";
                lastScreenshotId = undefined;
                return;
            }
            case "tool_execution_start": {
                endText();
                // Mark where the agent is about to act on the latest screenshot.
                const a: any = event.args ?? {};
                if (
                    lastScreenshotId &&
                    typeof a.x === "number" &&
                    typeof a.y === "number" &&
                    (event.toolName === "click" || event.toolName === "double_click" || event.toolName === "move_mouse")
                ) {
                    writer.write({
                        type: "data-marker",
                        data: {
                            screenshotId: lastScreenshotId,
                            x: a.x,
                            y: a.y,
                            kind: event.toolName === "move_mouse" ? "move" : (event.toolName as "click" | "double_click"),
                        },
                    });
                }
                writer.write({
                    type: "tool-input-available",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.args,
                });
                return;
            }
            case "tool_execution_end": {
                const img = imageFrom(event.result);
                if (img && event.toolName === "screenshot") {
                    lastScreenshotId = event.toolCallId;
                    writer.write({
                        type: "data-screenshot",
                        id: event.toolCallId,
                        data: {
                            toolCallId: event.toolCallId,
                            src: `data:${img.mimeType};base64,${img.data}`,
                            width: (event.result as any)?.details?.width ?? 0,
                            height: (event.result as any)?.details?.height ?? 0,
                        },
                    });
                }
                writer.write({
                    type: "tool-output-available",
                    toolCallId: event.toolCallId,
                    output: { summary: textFrom(event.result) || (event.isError ? "error" : "done"), isError: event.isError },
                });
                return;
            }
            default:
                return;
        }
    };
}
