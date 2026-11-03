/**
 * The step row for a PiKVM tool call (`mcp__pikvm_<tool>`, names from packages/pikvm-mcp). It says what the agent did
 * in one line, drawn from the call's arguments (all x,y are pixels of the last full screenshot's frame) and the
 * one-sentence result, and shows a failure's code. The result text is all the thread receives: a screenshot's image
 * block stays with the model, so there is no thumbnail here.
 */
import { CursorClickIcon, KeyboardIcon, MonitorIcon, PowerIcon, WarningCircleIcon } from "@pikvm/icons";
import { cn } from "../../lib/cn";

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

export function PikvmStep({
    name,
    args,
    output,
    state,
}: {
    name: string;
    args: string;
    output: string | undefined;
    state: "running" | "done" | "failed" | "stopped";
}) {
    const failed = state === "failed";
    const code = failed ? pikvmErrorCode(output) : undefined;
    return (
        <li data-pikvm-step="" data-state={state} className="act-step flex items-start gap-2 py-1 text-[14px] leading-5">
            <span className={cn("mt-0.5 shrink-0", failed ? "text-danger" : "text-secondary")}>
                {failed ? <WarningCircleIcon aria-hidden /> : iconFor(name.slice(PIKVM_PREFIX.length))}
            </span>
            <span className="min-w-0">
                <span className={cn(state === "running" && "text-secondary")}>{describePikvmCall(name, args)}</span>
                {output && (
                    <span className={cn("block truncate", failed ? "text-danger" : "text-tertiary")}>
                        {(code && CODE_LABEL[code]) || output}
                    </span>
                )}
            </span>
        </li>
    );
}
