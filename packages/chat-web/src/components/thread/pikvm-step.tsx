/**
 * The step row for a PiKVM tool call (`mcp__pikvm_<tool>`, names from packages/pikvm-mcp). It says what the agent did
 * in one line, drawn from the call's arguments (all x,y are pixels of the last full screenshot's frame) and the
 * one-sentence result, and shows a failure's code.
 *
 * With the result's frame (`FunctionCallOutputItem.frame`, kept by the server) it shows what the agent saw: a
 * thumbnail that opens full size in a sheet on a phone and a dialog on a desktop. For a click, move, drag or scroll the
 * frame is the screenshot its coordinates refer to, with the point drawn over it. The frame can be gone (the server
 * keeps a bounded number); the card then has no picture and says so.
 */
import type { ToolFrame } from "@pikvm/chat-protocol";
import { CursorClickIcon, KeyboardIcon, MonitorIcon, PowerIcon, WarningCircleIcon } from "@pikvm/icons";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { serverUrl } from "../../lib/config";
import { Dialog } from "../ui/dialog";
import "./activity/pikvm-frame.css";

export const PIKVM_PREFIX = "mcp__pikvm_";
export const isPikvmTool = (name: string): boolean => name.startsWith(PIKVM_PREFIX);

type Args = Record<string, unknown>;

function parse(args: string): Args {
    try {
        const v: unknown = JSON.parse(args);
        return v && typeof v === "object" ? (v as Args) : {};
    } catch {
        return {};
    }
}

const at = (x: unknown, y: unknown): string => (typeof x === "number" && typeof y === "number" ? ` at (${x}, ${y})` : "");

/** One line for the call: "Click (left) at (640, 360)". */
export function describePikvmCall(name: string, rawArgs: string): string {
    const a = parse(rawArgs);
    const tool = name.slice(PIKVM_PREFIX.length);
    switch (tool) {
        case "screenshot":
            return a.region ? "Zoom into the screen" : "Look at the screen";
        case "read_text":
            return "Read text from the screen";
        case "screen_info":
            return "Check the screen size";
        case "mouse_move":
            return `Move the mouse${at(a.x, a.y)}`;
        case "click":
            return `${a.count === 2 ? "Double-click" : "Click"}${typeof a.button === "string" ? ` (${a.button})` : ""}${at(a.x, a.y)}`;
        case "drag": {
            const f = a.from as Args | undefined;
            const t = a.to as Args | undefined;
            return `Drag${at(f?.x, f?.y)}${at(t?.x, t?.y).replace(" at", " to")}`;
        }
        case "scroll":
            return `Scroll${at(a.x, a.y)}`;
        case "type_text":
            return typeof a.text === "string" ? `Type ${a.text.length} characters` : "Type text";
        case "key":
            return `Press ${Array.isArray(a.keys) ? a.keys.join("+") : "keys"}`;
        case "wait":
            return "Wait for the screen";
        case "power":
            return `Power: ${typeof a.action === "string" ? a.action : "action"}`;
        default:
            return tool.replaceAll("_", " ");
    }
}

interface Point {
    x: number;
    y: number;
}

/** What a pointer tool did, in pixels of the screenshot it was aimed at. */
export type PikvmAction =
    | { kind: "click"; count: number; at: Point }
    | { kind: "move" | "scroll"; at: Point }
    | { kind: "drag"; from: Point; to: Point };

function asPoint(v: unknown): Point | undefined {
    if (!v || typeof v !== "object" || !("x" in v) || !("y" in v)) return undefined;
    return typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : undefined;
}

/** The point or points a pointer tool's arguments aim at; undefined for every other tool. */
export function pikvmAction(name: string, rawArgs: string): PikvmAction | undefined {
    const a = parse(rawArgs);
    const tool = name.slice(PIKVM_PREFIX.length);
    if (tool === "drag") {
        const from = asPoint(a.from);
        const to = asPoint(a.to);
        return from && to ? { kind: "drag", from, to } : undefined;
    }
    const at = asPoint(a);
    if (!at) return undefined;
    if (tool === "click") return { kind: "click", count: typeof a.count === "number" ? a.count : 1, at };
    if (tool === "mouse_move") return { kind: "move", at };
    return tool === "scroll" ? { kind: "scroll", at } : undefined;
}

/** The failure code at the start of an error result (`control_released: ...`). */
export function pikvmErrorCode(output: string | undefined): string | undefined {
    return /^([a-z_]+): /.exec(output ?? "")?.[1];
}

const CODE_LABEL: Record<string, string> = {
    control_released: "You took control, so the agent stopped",
    approval_denied: "You declined this action",
};

function iconFor(tool: string) {
    if (tool === "power") return <PowerIcon aria-hidden />;
    if (tool === "type_text" || tool === "key") return <KeyboardIcon aria-hidden />;
    if (tool === "click" || tool === "mouse_move" || tool === "drag" || tool === "scroll")
        return <CursorClickIcon aria-hidden />;
    return <MonitorIcon aria-hidden />;
}

const percent = (fraction: number): string => `${+(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(3)}%`;

/** The action drawn over a picture of `frame`'s size: a mark per point, and the line of a drag. */
function Marks({ frame, action }: { frame: ToolFrame; action: PikvmAction }) {
    const at = (p: Point) => ({ left: percent(p.x / frame.width), top: percent(p.y / frame.height) });
    if (action.kind === "drag") {
        // The picture keeps the frame's aspect ratio, so one frame pixel is the same length across and down: the line's
        // length (as a share of the picture's width) and its angle can be worked out in frame pixels.
        const dx = action.to.x - action.from.x;
        const dy = action.to.y - action.from.y;
        const line = {
            ...at(action.from),
            width: `${+((Math.hypot(dx, dy) / frame.width) * 100).toFixed(3)}%`,
            transform: `rotate(${+((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(3)}deg)`,
        };
        return (
            <span className="pk-marks" aria-hidden>
                <span data-pikvm-line="" className="pk-line" style={line} />
                <span data-pikvm-marker="" data-kind="drag" data-role="from" className="pk-mark" style={at(action.from)} />
                <span data-pikvm-marker="" data-kind="drag" data-role="to" className="pk-mark" style={at(action.to)} />
            </span>
        );
    }
    return (
        <span className="pk-marks" aria-hidden>
            <span
                data-pikvm-marker=""
                data-kind={action.kind}
                {...(action.kind === "click" ? { "data-count": action.count } : {})}
                className="pk-mark"
                style={at(action.at)}
            />
        </span>
    );
}

const KIND_WORDS: Record<PikvmAction["kind"], string> = {
    click: "click",
    move: "pointer move",
    scroll: "scroll",
    drag: "drag",
};

/** The screenshot, with the action over it. `onGone` is told when the server no longer has the picture. */
function FramePicture({
    frame,
    action,
    alt,
    onGone,
    style,
    className,
}: {
    frame: ToolFrame;
    action: PikvmAction | undefined;
    alt: string;
    onGone: () => void;
    style?: React.CSSProperties;
    className?: string;
}) {
    return (
        <span
            data-pikvm-frame=""
            className={cn("pk-frame", className)}
            style={{ aspectRatio: `${frame.width} / ${frame.height}`, ...style }}
        >
            <img src={serverUrl(frame.url)} alt={alt} width={frame.width} height={frame.height} decoding="async" onError={onGone} />
            {action && <Marks frame={frame} action={action} />}
        </span>
    );
}

/** The most of the screen's height the full-size picture takes, so it never needs scrolling to be seen whole. */
const VIEWER_HEIGHT_DVH = 65;

function FrameView({ frame, action, title }: { frame: ToolFrame; action: PikvmAction | undefined; title: string }) {
    const [open, setOpen] = useState(false);
    const [gone, setGone] = useState(false);
    if (gone) return <span className="pk-gone">The screenshot is no longer kept.</span>;
    const marked = action ? `, with the ${KIND_WORDS[action.kind]} marked` : "";
    return (
        <>
            <button
                type="button"
                data-pikvm-thumb=""
                className="pk-thumb"
                aria-label={`Open the screenshot full size${marked}`}
                onClick={() => setOpen(true)}
            >
                <FramePicture frame={frame} action={action} alt="" onGone={() => setGone(true)} />
            </button>
            <Dialog open={open} onOpenChange={setOpen} title={title} width={960}>
                <FramePicture
                    frame={frame}
                    action={action}
                    alt={`Screenshot${marked}`}
                    onGone={() => setGone(true)}
                    className="pk-viewer"
                    style={{ width: `min(100%, ${((VIEWER_HEIGHT_DVH * frame.width) / frame.height).toFixed(3)}dvh)` }}
                />
            </Dialog>
        </>
    );
}

export function PikvmStep({
    name,
    args,
    output,
    state,
    frame,
}: {
    name: string;
    args: string;
    output: string | undefined;
    state: "running" | "done" | "failed" | "stopped";
    /** The picture the result names, from `FunctionCallOutputItem.frame`. */
    frame?: ToolFrame | undefined;
}) {
    const failed = state === "failed";
    const code = failed ? pikvmErrorCode(output) : undefined;
    const title = describePikvmCall(name, args);
    return (
        <li data-pikvm-step="" data-state={state} className="act-step flex items-start gap-2 py-1 text-[length:var(--type-body,14px)] leading-5">
            <span className={cn("mt-0.5 shrink-0", failed ? "text-danger" : "text-secondary")}>
                {failed ? <WarningCircleIcon aria-hidden /> : iconFor(name.slice(PIKVM_PREFIX.length))}
            </span>
            <span className="min-w-0">
                <span className={cn(state === "running" && "text-secondary")}>{title}</span>
                {output && (
                    <span className={cn("block truncate", failed ? "text-danger" : "text-tertiary")}>
                        {(code && CODE_LABEL[code]) || output}
                    </span>
                )}
                {frame && !failed && <FrameView frame={frame} action={pikvmAction(name, args)} title={title} />}
            </span>
        </li>
    );
}
