import { useAuiState } from "@assistant-ui/react";
import { type ReactNode, useState } from "react";
import { useLongPress } from "../../hooks/use-long-press";
import { useCompact } from "../../layout/compact";
import { MessageActionsSheet } from "../workspace/message-actions-sheet";

/**
 * Long-press actions for the message this hook is called inside (phone layout only).
 *
 * Spread `handlers` on the message root and render `sheet` anywhere under it. Touch
 * callouts are switched off on the root so the system's own selection menu does not
 * race the sheet; the sheet's Copy is how text leaves a message on a phone.
 */
export function useMessageActions(): {
    handlers: ReturnType<typeof useLongPress>;
    style: React.CSSProperties | undefined;
    sheet: ReactNode;
} {
    const compact = useCompact();
    const [open, setOpen] = useState(false);
    const content = useAuiState((state) => state.message.content);
    const text = content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n")
        .trim();
    const enabled = compact && text.length > 0;
    const handlers = useLongPress(() => setOpen(true), { enabled });
    return {
        handlers,
        style: enabled ? { WebkitTouchCallout: "none" } : undefined,
        sheet: enabled ? <MessageActionsSheet open={open} onOpenChange={setOpen} text={text} /> : null,
    };
}
