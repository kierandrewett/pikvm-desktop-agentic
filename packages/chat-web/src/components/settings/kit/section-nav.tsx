/**
 * In-page section navigation for long settings pages (Authentication, Sandbox, MCP). It reads the titled
 * sections the page rendered (`section[data-settings-section]` with a `[data-section-title]`), so pages do not
 * list their sections twice. A button scrolls to the section and moves focus to its heading. The section that
 * sits under the header is marked with `aria-current`. Shown only when a page has three or more sections.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";

interface Item {
    id: string;
    title: string;
}

/** Top offset (px) under the sticky header where a section counts as the current one. */
const CURRENT_OFFSET = 140;

function scan(root: Element): Item[] {
    const items: Item[] = [];
    for (const section of root.querySelectorAll<HTMLElement>("section[data-settings-section][id]")) {
        const title = section.querySelector("[data-section-title]")?.textContent?.trim();
        if (title) items.push({ id: section.id, title });
    }
    return items;
}

const same = (a: Item[], b: Item[]): boolean =>
    a.length === b.length && a.every((item, i) => item.id === b[i]?.id && item.title === b[i]?.title);

export function SectionNav({ label }: { label: string }) {
    const nav = useRef<HTMLElement>(null);
    const [items, setItems] = useState<Item[]>([]);
    const [current, setCurrent] = useState<string>();

    useEffect(() => {
        const root = nav.current?.closest("[data-settings-page]");
        const scroller = nav.current?.closest("[data-settings-scroll]");
        if (!root) return;
        let frame = 0;
        const refresh = () => {
            frame = 0;
            const next = scan(root);
            setItems((previous) => (same(previous, next) ? previous : next));
            let active: string | undefined;
            for (const item of next) {
                const section = document.getElementById(item.id);
                if (section && section.getBoundingClientRect().top <= CURRENT_OFFSET) active = item.id;
            }
            setCurrent(active ?? next[0]?.id);
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(refresh);
        };
        refresh();
        const observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        scroller?.addEventListener("scroll", schedule, { passive: true });
        return () => {
            observer.disconnect();
            scroller?.removeEventListener("scroll", schedule);
            if (frame) cancelAnimationFrame(frame);
        };
    }, []);

    const go = (id: string) => {
        const section = document.getElementById(id);
        if (!section) return;
        const motion = document.documentElement.dataset.reducedMotion;
        const reduced =
            motion === "on" || (motion !== "off" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        section.scrollIntoView({ block: "start", behavior: reduced ? "instant" : "smooth" });
        const heading = section.querySelector<HTMLElement>("[data-section-title]");
        if (heading) {
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
        }
        setCurrent(id);
    };

    return (
        <nav
            ref={nav}
            aria-label={label}
            data-section-nav=""
            hidden={items.length < 3}
            className="flex gap-1.5 overflow-x-auto pb-2 [scrollbar-width:none]"
        >
            {items.length >= 3 &&
                items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        aria-current={current === item.id ? "location" : undefined}
                        onClick={() => go(item.id)}
                        className={cn(
                            "inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sm outline-none pointer-coarse:h-10",
                            "focus-visible:outline-2 focus-visible:outline-ring",
                            current === item.id
                                ? "bg-selected font-medium text-text"
                                : "text-secondary hover-device:hover:bg-hover hover-device:hover:text-text",
                        )}
                    >
                        {item.title}
                    </button>
                ))}
        </nav>
    );
}
