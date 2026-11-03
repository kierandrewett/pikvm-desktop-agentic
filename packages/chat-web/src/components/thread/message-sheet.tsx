/**
 * Long-press action sheet for messages on touch screens, as in messaging apps.
 *
 * Holding a finger on a message (user bubble or finished answer) for LONG_PRESS_MS opens a bottom sheet with
 * everything the hover row under the message offers: the quick reactions and the full emoji picker, Copy, Read
 * aloud, Sources, plus Select text, which turns on native text selection for that one message.
 *
 * Gesture rules:
 * - Touch only (`pointerType === "touch"`). Mouse and pen keep the desktop behaviour: hover row, right-click menu.
 * - The press shows after PRESS_VISUAL_MS (a slight scale or tint), so a tap that starts a scroll does not flash.
 * - Moving more than MOVE_TOLERANCE px, a second finger, or the browser taking the touch for a scroll
 *   (pointercancel) cancels the press.
 * - Links, buttons, form fields, images and summaries keep their own long-press (link preview, image save).
 * - On touch, message text is not selectable until Select text (message-sheet.css), so the browser's own
 *   selection and callout do not fight the sheet. Select text selects the whole message; the native handles
 *   then adjust it. A tap outside the message ends the mode.
 * - The tap that ends a long-press does not also activate what is under the finger, and Android's long-press
 *   `contextmenu` is suppressed while a press is pending or has fired.
 *
 * Sheet: Escape, the scrim or a swipe down closes it (ui/sheet.tsx). When it closes, focus goes to the message
 * (tabindex -1), never back to the composer, which would bring up the on-screen keyboard.
 *
 * `useMessageSheet` returns props to spread on the message element and the sheet element to render beside it.
 * It returns no props in thread previews or before the conversation exists.
 */
import type { OutputItem } from "@pikvm/chat-protocol";
import { CopyIcon, CursorTextIcon } from "@pikvm/icons";
import {
    useCallback,
    useContext,
    useMemo,
    useEffect,
    useRef,
    useState,
    type MouseEvent,
    type PointerEvent,
    type ReactNode,
} from "react";
import { useT } from "../../l10n/provider";
import { msg, translate } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import { sheetRow } from "../ui/menu";
import { Sheet } from "../ui/sheet";
import { toast } from "../ui/toast";
import { BranchSheetRows } from "./branch-buttons";
import { ThreadContext } from "./context";
import "./message-sheet.css";

/** iOS and Android open their own long-press menus at about 500 ms; a little sooner feels responsive. */
const LONG_PRESS_MS = 450;
const PRESS_VISUAL_MS = 130;
const MOVE_TOLERANCE = 10;
const KEEP_NATIVE = "a, button, input, textarea, select, summary, img, video, [contenteditable], [role='button']";

export interface MessageSheetOptions {
    itemId: string;
    role: "user" | "assistant";
    /** The message as Copy copies it (markdown for answers). */
    text: string;
    /** The turn's items, for the Sources row. */
    items?: readonly OutputItem[];
}

export interface MessagePressProps {
    "data-msg-press"?: "bubble" | "text";
    "data-selecting"?: "";
    onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove?: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel?: (e: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture?: (e: PointerEvent<HTMLElement>) => void;
    onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
    onClickCapture?: (e: MouseEvent<HTMLElement>) => void;
}

interface Press {
    id: number;
    x: number;
    y: number;
    el: HTMLElement;
    visual: ReturnType<typeof setTimeout>;
    fire: ReturnType<typeof setTimeout>;
}

export function useMessageSheet(opts: MessageSheetOptions): { props: MessagePressProps; sheet: ReactNode } {
    const { conversationId, preview } = useContext(ThreadContext);
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const press = useRef<Press | null>(null);
    const fired = useRef(false);
    const target = useRef<HTMLElement | null>(null);
    const active = !preview && !!conversationId;

    const cancel = useCallback(() => {
        const p = press.current;
        if (!p) return;
        clearTimeout(p.visual);
        clearTimeout(p.fire);
        delete p.el.dataset.pressing;
        press.current = null;
    }, []);

    // Unmount or a new message id: drop a pending press.
    useEffect(() => cancel, [cancel, opts.itemId]);

    // Select text: select the whole message once the sheet has gone, and end the mode on a tap elsewhere.
    useEffect(() => {
        if (!selecting) return;
        const el = target.current;
        const frame = requestAnimationFrame(() => {
            if (!el?.isConnected) return;
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
        const onDown = (e: globalThis.PointerEvent) => {
            if (el && !el.contains(e.target as Node)) setSelecting(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("pointerdown", onDown, true);
        };
    }, [selecting]);

    const props = useMemo<MessagePressProps>(() => {
        if (!active) return {};
        const kind = opts.role === "user" ? "bubble" : "text";
        if (selecting) return { "data-msg-press": kind, "data-selecting": "" };
        return {
            "data-msg-press": kind,
            onPointerDown: (e) => {
                fired.current = false;
                if (e.pointerType !== "touch" || !e.isPrimary) {
                    cancel();
                    return;
                }
                if ((e.target as Element).closest(KEEP_NATIVE)) return;
                cancel();
                const el = e.currentTarget;
                const visual = setTimeout(() => {
                    el.dataset.pressing = "";
                }, PRESS_VISUAL_MS);
                const fire = setTimeout(() => {
                    press.current = null;
                    delete el.dataset.pressing;
                    if (!el.isConnected) return;
                    // The shell took the pointer for a drawer or panel drag (it captures the pointer, so this element
                    // sees no more moves): the finger is not resting on the message, so this is not a long-press.
                    if (el.closest("[data-dragging='true']")) return;
                    fired.current = true;
                    target.current = el;
                    window.getSelection()?.removeAllRanges();
                    navigator.vibrate?.(10);
                    setMounted(true);
                    setOpen(true);
                }, LONG_PRESS_MS);
                press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, el, visual, fire };
            },
            onPointerMove: (e) => {
                const p = press.current;
                if (!p || p.id !== e.pointerId) return;
                if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancel();
            },
            onPointerUp: cancel,
            onPointerCancel: cancel,
            // A touch is captured by its target; the shell takes that capture when a drawer or panel drag engages
            // (drawer-gesture.ts), so the message sees no release. The lost capture is the end of the press.
            onLostPointerCapture: cancel,
            // Android fires contextmenu on long-press; the sheet replaces it.
            onContextMenu: (e) => {
                if (fired.current || press.current) e.preventDefault();
            },
            // The tap that ends a long-press must not also activate what is under the finger.
            onClickCapture: (e) => {
                if (!fired.current) return;
                fired.current = false;
                e.preventDefault();
                e.stopPropagation();
            },
        };
    }, [active, opts.role, selecting, cancel]);

    const onCloseAutoFocus = useCallback((e: Event) => {
        e.preventDefault();
        const el = target.current;
        if (!el?.isConnected) return;
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
    }, []);

    const sheet =
        active && mounted ? (
            <MessageSheet
                {...opts}
                open={open}
                onOpenChange={setOpen}
                onSelectText={() => {
                    setOpen(false);
                    setSelecting(true);
                }}
                onCloseAutoFocus={onCloseAutoFocus}
            />
        ) : null;
    return { props, sheet };
}

function MessageSheet({
    role,
    text,
    open,
    onOpenChange,
    onSelectText,
    onCloseAutoFocus,
    itemId,
}: MessageSheetOptions & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelectText: () => void;
    onCloseAutoFocus: (e: Event) => void;
}) {
    const t = useT();
    const close = () => onOpenChange(false);
    const title = t(role === "user" ? msg("message-sheet-title-user") : msg("message-sheet-title-assistant"));

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            titleHidden
            description={t("message-sheet-description")}
            onCloseAutoFocus={onCloseAutoFocus}
            className="message-sheet"
        >
            {/* A reminder of which message this is. */}
            <p
                aria-hidden
                className={cn(
                    "mx-3 mt-1 mb-2 line-clamp-2 text-sm leading-5 break-words text-secondary",
                    role === "user" && "whitespace-pre-wrap",
                )}
            >
                {text}
            </p>
            <div role="group" aria-label={t("message-sheet-actions")} className="flex flex-col pt-1 pb-1">
                <button
                    type="button"
                    className={sheetRow}
                    onClick={() => {
                        close();
                        void navigator.clipboard?.writeText(text).then(
                            () => toast.success(translate("message-sheet-copied"), { id: "message-copy" }),
                            () => toast.error(translate("message-sheet-copy-failed"), { id: "message-copy" }),
                        );
                    }}
                >
                    <CopyIcon aria-hidden />
                    {t(role === "user" ? msg("message-sheet-copy-message") : msg("message-sheet-copy"))}
                </button>
                <button type="button" className={sheetRow} onClick={onSelectText}>
                    <CursorTextIcon aria-hidden />
                    {t("message-sheet-select-text")}
                </button>
                <BranchSheetRows itemId={itemId} role={role} onDone={close} />
            </div>
        </Sheet>
    );
}
