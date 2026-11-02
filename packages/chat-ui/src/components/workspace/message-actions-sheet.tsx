import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

/**
 * What a long-press on a message offers. Today that is Copy, the one action a phone has
 * no other way to do: text is not selectable inside the app shell, and a hover action bar
 * does not exist under a thumb.
 *
 * The clipboard write can be refused (an insecure origin, a denied permission), and a
 * sheet that says "Copied" regardless would be a lie, so the row reports what happened.
 */
export function MessageActionsSheet({
    open,
    onOpenChange,
    text,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    text: string;
}) {
    const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");

    useEffect(() => {
        if (!open) setResult("idle");
    }, [open]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setResult("copied");
            window.setTimeout(() => onOpenChange(false), 600);
        } catch {
            setResult("failed");
        }
    };

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="bottom" showCloseButton={false} className="gap-0 rounded-t-2xl pb-[var(--chat-safe-bottom,0px)]">
                <SheetHeader>
                    <SheetTitle>Message</SheetTitle>
                    <SheetDescription className="line-clamp-2">{text}</SheetDescription>
                </SheetHeader>
                <div className="flex flex-col p-2">
                    <button
                        type="button"
                        onClick={() => void copy()}
                        className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-accent"
                    >
                        {result === "copied" ? (
                            <CheckIcon className="size-4" aria-hidden="true" />
                        ) : (
                            <CopyIcon className="size-4" aria-hidden="true" />
                        )}
                        {result === "copied" ? "Copied" : "Copy text"}
                    </button>
                    {result === "failed" ? (
                        <p role="alert" className="px-3 pb-2 text-[13px] text-destructive">
                            The browser would not let this page copy. Select the text instead.
                        </p>
                    ) : null}
                </div>
            </SheetContent>
        </Sheet>
    );
}
