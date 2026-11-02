import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Children, isValidElement, type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";

/** A block longer than this starts collapsed; the full text is one tap away. */
export const COLLAPSE_AFTER_LINES = 24;

/** The plain text inside a rendered code element, whatever highlighting wrapped it. */
export function textOf(node: ReactNode): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
    return "";
}

export const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/**
 * The body of a fenced code block. Long ones collapse behind a fade so a pasted log does
 * not push the rest of the conversation off screen; the toggle names the size so it is
 * clear what is being skipped. Short blocks are untouched.
 */
export function CodeBlockBody({ className, children, ...props }: ComponentProps<"pre">) {
    const lines = lineCount(textOf(Children.toArray(children)));
    const collapsible = lines > COLLAPSE_AFTER_LINES;
    const [expanded, setExpanded] = useState(false);
    const collapsed = collapsible && !expanded;

    return (
        <div className="aui-code-block relative" data-collapsed={collapsed} data-lines={lines}>
            <pre
                className={cn(
                    "aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed",
                    collapsed && "max-h-72 overflow-y-hidden",
                    className,
                )}
                {...props}
            >
                {children}
            </pre>
            {collapsed ? (
                <div
                    className="from-background pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b-xl bg-gradient-to-t to-transparent"
                    aria-hidden="true"
                />
            ) : null}
            {collapsible ? (
                <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    aria-expanded={expanded}
                    className={cn(
                        "text-muted-foreground hover:text-foreground compact:min-h-11 flex w-full items-center justify-center gap-1 py-1 text-xs",
                        collapsed && "absolute inset-x-0 bottom-1 z-10 w-auto",
                    )}
                >
                    {expanded ? <ChevronUpIcon className="size-3.5" aria-hidden="true" /> : <ChevronDownIcon className="size-3.5" aria-hidden="true" />}
                    {expanded ? "Collapse" : `Show all ${lines} lines`}
                </button>
            ) : null}
        </div>
    );
}
