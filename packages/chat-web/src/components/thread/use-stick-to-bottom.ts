/**
 * Keep a scroller pinned to the bottom while its content grows, unless the user scrolled up.
 *
 * The reference uses a `column-reverse` scroller for this. We use a normal-flow scroller with a
 * ResizeObserver instead: it is pinned the same way at the bottom, but when the user has scrolled up
 * the text they are reading stays still while a response streams below (with column-reverse it drifts
 * upward), and expanding a row pushes content down as people expect.
 *
 * - First layout: jump to the bottom before paint (no visible scroll animation).
 * - Content or viewport resize: if pinned, write scrollTop in the same frame (ResizeObserver runs
 *   after layout, before paint).
 * - Scroll: moving up unpins; reaching the bottom pins again. Programmatic downward scrolls never unpin.
 * - State updates are booleans, so React bails out of re-renders while the value does not change.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const BOTTOM_PX = 8;

export interface StickToBottom {
    scrollRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    atBottom: boolean;
    /** The thread is scrolled away from its top (header shows its background). */
    scrolled: boolean;
    scrollToBottom: (smooth?: boolean) => void;
}

export function useStickToBottom(): StickToBottom {
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const lastTop = useRef(0);
    const [atBottom, setAtBottom] = useState(true);
    const [scrolled, setScrolled] = useState(false);

    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PX;
        setAtBottom(bottom);
        setScrolled(el.scrollTop > 0);
    }, []);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        lastTop.current = el.scrollTop;
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        const content = contentRef.current;
        if (!el || !content) return;
        const onResize = () => {
            if (pinned.current) el.scrollTop = el.scrollHeight;
            lastTop.current = el.scrollTop;
            measure();
        };
        const onScroll = () => {
            const top = el.scrollTop;
            if (el.scrollHeight - top - el.clientHeight <= BOTTOM_PX) pinned.current = true;
            else if (top < lastTop.current - 1) pinned.current = false;
            lastTop.current = top;
            measure();
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(content);
        ro.observe(el);
        // A disclosure toggled by the user asks to stop following the bottom so the toggle stays put.
        const onUnpin = () => {
            pinned.current = false;
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        el.addEventListener("chat:unpin", onUnpin);
        return () => {
            ro.disconnect();
            el.removeEventListener("scroll", onScroll);
            el.removeEventListener("chat:unpin", onUnpin);
        };
    }, [measure]);

    const scrollToBottom = useCallback((smooth = true) => {
        const el = scrollRef.current;
        if (!el) return;
        pinned.current = true;
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    }, []);

    return { scrollRef, contentRef, atBottom, scrolled, scrollToBottom };
}
