/**
 * Inline suggestion menu and its data: "+" and "@" (attachments, MCP servers and tools, workspace files) and
 * "/" (commands). Measured on the reference web composer (web notes A.4, ui-spec 3.3):
 *
 * - "@" with nothing after it shows the same list as "+": actions first, then connectors (our MCP servers),
 *   then a "Type to search ..." footer. Typing after "@" filters and adds sticky section headers.
 * - Surface: composer width, 4px from the composer, 8px padding, 1px border, 20px radius, menu background,
 *   no shadow, max height 378px with a 1rem edge fade. No open or close animation.
 * - Rows: 36px, padding 6px 8px, radius 12px, 20px icon slot, 12px gaps, title then description on one line,
 *   both 14px/20px, description tertiary. The first row is active on open; the pointer moves the active row.
 * - Section header: sticky, 28px, padding 4px 8px, 14px tertiary on the menu background.
 *
 * Focus stays in the editor: the composer routes the menu keys here (menuKeyAction). Keys, the same at every level:
 * - Up and Down move the highlight and wrap at the ends; section headers are not rows, so they are skipped.
 *   Home and End go to the first and last row, PageUp and PageDown by the rows that fit (they stop at the ends).
 * - Enter or Tab picks the row. A row with a trailing caret (`more`: an MCP server, a command with arguments)
 *   opens its level instead, and so does ArrowRight on it.
 * - ArrowLeft, Backspace or Escape with nothing typed in a level goes back one level, with the row it came from
 *   highlighted (menuBack). Escape on the first level closes the menu and keeps the text.
 * - Typing filters at every level, because a level is text: "@notes/" is the notes server's level.
 *
 * Phones (`sheet`): the menu is a sheet from edge to edge of the screen. It reaches down behind the composer to the
 * bottom of the screen (the top of the keyboard when it is open), so the composer sits on it, and its rows end just
 * above the composer. Its height is capped by the room above the composer, so it never runs off the top.
 */
import {
    ArrowClockwise,
    ArrowsInSimple,
    Brain,
    Broom,
    CaretRight,
    ChartBar,
    Check,
    CheckCircle,
    Command,
    Cube,
    Eraser,
    File,
    FileText,
    FolderSimple,
    Gauge,
    GitPullRequest,
    Handshake,
    ListChecks,
    MagnifyingGlass,
    NotePencil,
    Paperclip,
    PencilSimpleLine,
    Plugs,
    Sparkle,
    Terminal,
    Wrench,
} from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import {
    Fragment,
    memo,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
    type RefObject,
} from "react";
import { msg, translate } from "../../l10n/runtime";
import { useThemeLayer } from "../../lib/theme-scope";
import { api } from "../../lib/api";
import { appHeight } from "../../lib/app-height";
import { cn } from "../../lib/cn";
import { ChipGlyph, type ChipKind } from "./chips";

export interface SuggestItem {
    id: string;
    title: string;
    description?: string;
    /** Description in the danger tone (for example an MCP server that failed to start). */
    problem?: boolean;
    hint?: string;
    icon: ReactNode;
    /** The chip this row inserts ("@" mention or "/" command): the icon is drawn on the shared chip surface. */
    chip?: Extract<ChipKind, "mention" | "command">;
    /** Indexes of title characters that matched the query; the rest of the title is dimmed (reference "/" menu). */
    matches?: number[];
    /** Trailing caret for rows that open a second level. */
    more?: boolean;
    /** Current value in an argument list (trailing check, as in the reference menus). */
    checked?: boolean;
    /** Shown but not selectable (for example agent commands on the home screen). */
    disabled?: boolean;
}

export interface SuggestSection {
    label?: string;
    items: SuggestItem[];
}

export type Trigger =
    | { kind: "command" | "mention"; start: number; query: string }
    | { kind: "argument"; command: ArgCommand; start: number; query: string };

/** What a key does in an open menu (menuKeyAction). */
export type MenuAction =
    | { type: "move"; index: number }
    | { type: "pick"; viaTab: boolean }
    | { type: "drill" }
    | { type: "back" }
    | { type: "close" };

export interface MenuKeyState {
    /** Rows in the menu. */
    count: number;
    active: number;
    /** Rows that fit in the visible list, for PageUp and PageDown. */
    page: number;
    /** The highlighted row opens a deeper level. */
    canDrill: boolean;
    /** The menu shows a level below the first and nothing is typed in it. */
    canGoBack: boolean;
    /** Enter runs the typed text (a fully typed "/command"), so it is not a pick. */
    enterRuns: boolean;
}

/**
 * The action for a key in an open menu, or null when the editor keeps the key (a caret move, a new line). Keys with
 * Ctrl, Alt or Meta always stay with the editor.
 */
export function menuKeyAction(
    key: string,
    mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean },
    s: MenuKeyState,
): MenuAction | null {
    if (mods.ctrl || mods.alt || mods.meta) return null;
    const last = Math.max(0, s.count - 1);
    switch (key) {
        case "ArrowDown":
            return { type: "move", index: s.count ? (s.active + 1) % s.count : 0 };
        case "ArrowUp":
            return { type: "move", index: s.count ? (s.active - 1 + s.count) % s.count : 0 };
        case "Home":
            return s.count && !mods.shift ? { type: "move", index: 0 } : null;
        case "End":
            return s.count && !mods.shift ? { type: "move", index: last } : null;
        case "PageDown":
            return s.count ? { type: "move", index: Math.min(last, s.active + s.page) } : null;
        case "PageUp":
            return s.count ? { type: "move", index: Math.max(0, s.active - s.page) } : null;
        case "Tab":
            return s.count && !mods.shift ? (s.canDrill ? { type: "drill" } : { type: "pick", viaTab: true }) : null;
        case "Enter":
            if (mods.shift || s.enterRuns || !s.count) return null;
            return s.canDrill ? { type: "drill" } : { type: "pick", viaTab: false };
        case "ArrowRight":
            return s.canDrill && !mods.shift ? { type: "drill" } : null;
        case "ArrowLeft":
        case "Backspace":
            return s.canGoBack && !mods.shift ? { type: "back" } : null;
        case "Escape":
            return s.canGoBack ? { type: "back" } : { type: "close" };
        default:
            return null;
    }
}

/**
 * One level up from `trigger`, when nothing is typed in its level: the text that replaces the trigger's span (from
 * `from` to the caret) and the ids of the row to highlight there. "@notes/" goes back to "@" with the notes row, a
 * folder "@src/lib/" to "@src/", and "/effort " to "/" with the effort row. Null on the first level.
 */
export function menuBack(trigger: Trigger): { from: number; text: string; highlight: string[] } | null {
    if (trigger.kind === "argument") {
        if (trigger.query) return null;
        return { from: 0, text: "/", highlight: [`cmd:app:${trigger.command}`] };
    }
    if (trigger.kind !== "mention" || !trigger.query.endsWith("/")) return null;
    const path = trigger.query.slice(0, -1);
    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    const segment = path.slice(parent.length);
    return {
        from: trigger.start,
        text: `@${parent}`,
        highlight: [`mcp:${segment}`, `file:${path}/`, `file:${path}`],
    };
}

/** App commands whose argument the menu completes. */
export const ARG_COMMANDS = ["effort", "model", "permission", "new"] as const;
export type ArgCommand = (typeof ARG_COMMANDS)[number];

/**
 * "/" at the start of a line, "@" at the start or after whitespace, or the argument of an app command
 * ("/effort hi"), up to the caret.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
    const before = text.slice(0, caret);
    const arg = /^\/(effort|model|permission|new)\s+(\S*)$/.exec(before);
    if (arg)
        return {
            kind: "argument",
            command: arg[1] as ArgCommand,
            start: caret - (arg[2]?.length ?? 0),
            query: arg[2] ?? "",
        };
    const cmd = /(^|\n)\/([^\s/]*)$/.exec(before);
    if (cmd) return { kind: "command", start: caret - (cmd[2]?.length ?? 0) - 1, query: cmd[2] ?? "" };
    const at = /(^|\s)@(\S*)$/.exec(before);
    if (at) return { kind: "mention", start: caret - (at[2]?.length ?? 0) - 1, query: at[2] ?? "" };
    return null;
}

export interface CommandInfo {
    name: string;
    description?: string;
    source: "app" | "agent" | "skill" | "mcp";
    hint?: string;
}

export interface McpTool {
    name: string;
    label: string;
    description?: string;
}

export interface McpServer {
    name: string;
    type: string;
    owner: "global" | "user" | "builtin";
    connected: boolean;
    error?: string;
    tools: McpTool[];
}

const ICON = "size-5";

const COMMAND_ICONS: Record<string, ReactNode> = {
    new: <NotePencil className={ICON} />,
    model: <Cube className={ICON} />,
    effort: <Brain className={ICON} />,
    clear: <Eraser className={ICON} />,
    dump: <FileText className={ICON} />,
    todo: <ListChecks className={ICON} />,
    usage: <ChartBar className={ICON} />,
    tools: <Wrench className={ICON} />,
    context: <Gauge className={ICON} />,
    compact: <ArrowsInSimple className={ICON} />,
    shake: <Broom className={ICON} />,
    handoff: <Handshake className={ICON} />,
    retry: <ArrowClockwise className={ICON} />,
    memory: <Brain className={ICON} />,
    autoresearch: <MagnifyingGlass weight="regular" className={ICON} />,
    green: <CheckCircle className={ICON} />,
    review: <GitPullRequest className={ICON} />,
    annotate: <PencilSimpleLine className={ICON} />,
    init: <File className={ICON} />,
};

function commandIcon(c: CommandInfo): ReactNode {
    const known = COMMAND_ICONS[c.name];
    if (known) return known;
    if (c.source === "app") return <Command className={ICON} />;
    if (c.source === "skill") return <Sparkle className={ICON} />;
    if (c.source === "mcp") return <Plugs className={ICON} />;
    return <Terminal className={ICON} />;
}

/** "setup-pre-commit" -> "Setup pre commit": the reference lists commands by name, not as "/name". */
export function commandTitle(name: string): string {
    const words = name.replace(/[-_:]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

const SOURCE_FALLBACK_ID: Record<CommandInfo["source"], string> = {
    app: msg("composer-source-app"),
    agent: msg("composer-source-agent"),
    skill: msg("composer-source-skill"),
    mcp: msg("composer-source-mcp"),
};

/** Commands for "/" (GET /api/commands). Errors and missing endpoints give an empty list. */
export function useCommands(enabled: boolean, conversationId: string | undefined) {
    return useQuery({
        queryKey: ["commands", conversationId ?? null],
        queryFn: async () =>
            (
                await api.get<{ commands: CommandInfo[] }>(
                    `/commands${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}`,
                )
            ).commands,
        enabled,
        staleTime: 60_000,
        retry: false,
    });
}

/** MCP servers and tools (GET /api/mcp). Loaded only when the user opens tool suggestions. */
export function useMcp(enabled = false) {
    return useQuery({
        queryKey: ["mcp"],
        enabled,
        queryFn: async () => (await api.get<{ servers: McpServer[] }>("/mcp")).servers,
        staleTime: 5 * 60_000,
        retry: false,
    });
}

export interface McpResource {
    uri: string;
    name: string;
    title?: string;
    description?: string;
}

/**
 * Resources one MCP server lists (GET /api/mcp/servers/:id/inventory). Loaded only while "@server/" is typed.
 * The id of a remote server is its name. Resources whose address holds a space are left out: they cannot be a chip.
 */
export function useMcpResources(enabled: boolean, server: string | undefined) {
    return useQuery({
        queryKey: ["mcp-resources", server ?? null],
        enabled: enabled && !!server,
        queryFn: async () =>
            (
                await api.get<{ resources: McpResource[] }>(`/mcp/servers/${encodeURIComponent(server!)}/inventory`)
            ).resources.filter((r) => !/\s/.test(r.uri)),
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** The chip text for a resource: "mcp://<server>/<uri>". The server's address tells which server to ask. */
export const resourceToken = (server: string, uri: string) => `mcp://${server}/${uri}`;

export function resourceItem(r: McpResource): SuggestItem {
    return {
        id: `resource:${r.uri}`,
        title: r.title || r.name,
        description: r.description || r.uri,
        icon: <File className={ICON} />,
        chip: "mention",
    };
}

/** In-order subsequence match of `q` in `text`; returns matched indexes, preferring word starts. */
function fuzzy(text: string, q: string): number[] | null {
    const t = text.toLowerCase();
    const out: number[] = [];
    let from = 0;
    for (const ch of q) {
        // Prefer the next word start that has this character, then any occurrence.
        let at = -1;
        for (let k = from; k < t.length; k++) {
            if (t[k] === ch && (k === 0 || /[\s\-_/]/.test(t[k - 1] ?? ""))) {
                at = k;
                break;
            }
        }
        if (at < 0) at = t.indexOf(ch, from);
        if (at < 0) return null;
        out.push(at);
        from = at + 1;
    }
    return out;
}

export interface CommandMatch {
    command: CommandInfo;
    matches?: number[];
}

/** Filter and rank commands: name prefix, then word-start or subsequence on the title, then description. */
export function filterCommands(commands: CommandInfo[], query: string): CommandMatch[] {
    const q = query.toLowerCase();
    if (!q) return commands.map((command) => ({ command }));
    const scored: { m: CommandMatch; score: number }[] = [];
    for (const command of commands) {
        const title = commandTitle(command.name);
        if (command.name.toLowerCase().startsWith(q)) {
            scored.push({ m: { command, matches: [...Array(q.length).keys()] }, score: 3000 - command.name.length });
            continue;
        }
        const hit = fuzzy(title, q);
        if (hit) {
            const gaps = (hit.at(-1) ?? 0) - (hit[0] ?? 0) - hit.length;
            scored.push({ m: { command, matches: hit }, score: 2000 - gaps * 10 - (hit[0] ?? 0) });
            continue;
        }
        if (q.length >= 3 && (command.description ?? "").toLowerCase().includes(q))
            scored.push({ m: { command }, score: 1000 });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.m);
}

export function commandItem({ command: c, matches }: CommandMatch): SuggestItem {
    return {
        more: c.source === "app" && (ARG_COMMANDS as readonly string[]).includes(c.name),
        id: `cmd:${c.source}:${c.name}`,
        title: commandTitle(c.name),
        description: c.description || translate(SOURCE_FALLBACK_ID[c.source]),
        hint: c.hint,
        icon: commandIcon(c),
        chip: "command",
        matches,
    };
}

export function serverItem(s: McpServer): SuggestItem {
    const toolCount = translate("composer-server-tools", { count: s.tools.length });
    return {
        more: s.connected && s.tools.length > 0,
        id: `mcp:${s.name}`,
        title: s.name,
        description: s.connected
            ? toolCount
            : s.error
              ? translate("composer-server-not-connected-error", { error: s.error })
              : translate("composer-server-not-connected"),
        problem: !s.connected,
        icon: <Plugs className={ICON} />,
        chip: "mention",
    };
}

/** The first row of a server's level: the whole server as one "@" chip (the server row itself opens the level). */
export function wholeServerItem(s: McpServer): SuggestItem {
    return {
        id: `mcp-all:${s.name}`,
        title: s.name,
        description: translate("composer-server-whole"),
        icon: <Plugs className={ICON} />,
        chip: "mention",
    };
}

export function toolItem(server: string, t: McpTool): SuggestItem {
    return {
        id: `tool:${server}/${t.name}`,
        title: t.label || `${server}/${t.name}`,
        description: t.description,
        icon: <Wrench className={ICON} />,
        chip: "mention",
    };
}

export function attachItem(): SuggestItem {
    return {
        id: "plus:files",
        title: translate("composer-add-photos-files"),
        description: translate("composer-upload-from-device"),
        icon: <Paperclip className={ICON} />,
    };
}

/** Matched characters keep the ink colour; the rest of a matched title is tertiary. */
function Title({ text, matches }: { text: string; matches?: number[] }) {
    if (!matches?.length) return <>{text}</>;
    const hit = new Set(matches);
    const parts: ReactNode[] = [];
    let run = "";
    let runHit = hit.has(0);
    const flush = (k: number) => {
        if (run)
            parts.push(
                runHit ? (
                    <span key={k}>{run}</span>
                ) : (
                    <span key={k} className="text-tertiary">
                        {run}
                    </span>
                ),
            );
        run = "";
    };
    for (let k = 0; k < text.length; k++) {
        const h = hit.has(k);
        if (h !== runHit) {
            flush(k);
            runHit = h;
        }
        run += text[k];
    }
    flush(text.length);
    return <>{parts}</>;
}

const Row = memo(function Row({
    item,
    id,
    active,
    index,
    onHover,
    onPick,
    tall,
}: {
    item: SuggestItem;
    id: string;
    active: boolean;
    index: number;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    /** Phone sheet: 48px rows at any width (a phone on its side is wider than the max-md breakpoint). */
    tall: boolean;
}) {
    return (
        <div
            id={id}
            role="option"
            aria-selected={active}
            aria-disabled={item.disabled || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !active && onHover(index)}
            // Keep focus in the editor.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => !item.disabled && onPick(index)}
            className={cn(
                "flex w-full cursor-default items-center gap-3 rounded-xl px-2 py-1.5 text-base leading-5 font-[400] text-text select-none",
                tall ? "min-h-12" : "min-h-9 max-md:min-h-11",
                active && "bg-hover",
                item.disabled && "opacity-40",
            )}
        >
            {item.chip ? (
                <ChipGlyph kind={item.chip} active={active}>
                    {item.icon}
                </ChipGlyph>
            ) : (
                <span className="flex size-5 shrink-0 items-center justify-center">{item.icon}</span>
            )}
            <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
                <span className="max-w-[60%] min-w-0 shrink-0 truncate">
                    <Title text={item.title} matches={item.matches} />
                </span>
                {item.description && (
                    <span className={cn("min-w-0 flex-1 truncate", item.problem ? "text-danger" : "text-tertiary")}>
                        {item.description}
                    </span>
                )}
            </span>
            {item.hint && (
                <span className="max-w-[40%] shrink-0 truncate text-tertiary max-md:hidden">{item.hint}</span>
            )}
            {item.more && <CaretRight aria-hidden className="size-4 shrink-0 text-tertiary" />}
            {item.checked && <Check aria-hidden className="size-4 shrink-0 opacity-75" />}
        </div>
    );
});

export function InlineMenu({
    id,
    label,
    sections,
    active,
    placement,
    status,
    footer,
    onHover,
    onPick,
    sheet,
    float,
}: {
    id: string;
    label: string;
    sections: SuggestSection[];
    active: number;
    placement: "above" | "below";
    /** Shown when there are no rows ("Loading...", "No commands", "No files"). */
    status: string;
    footer?: string;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    /** Phones: the composer the sheet sits behind. The menu must be its child, positioned against it. */
    sheet?: RefObject<HTMLElement | null>;
    /**
     * Wide layouts: float the menu (portal, position fixed) against `anchor` (the composer surface), so no overflow
     * ancestor clips it and it takes no room in the layout. `button` is the element a "+" menu lines up with.
     */
    float?: { anchor: RefObject<HTMLElement | null>; button?: string };
}) {
    const scroller = useRef<HTMLDivElement>(null);
    const count = sections.reduce((n, s) => n + s.items.length, 0);
    const place = useSheetPlacement(sheet);
    const floatPlace = useFloatPlacement(float, placement);
    const layer = useThemeLayer();

    useLayoutEffect(() => {
        if (active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    }, [active, id]);

    const updateFade = () => {
        const el = scroller.current;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        el.style.setProperty("--fade-top", el.scrollTop > 1 ? "1rem" : "0px");
        el.style.setProperty("--fade-bottom", el.scrollTop < max - 1 ? "1rem" : "0px");
    };
    useLayoutEffect(updateFade);

    let index = 0;
    const menu = (
        <div
            data-suggest-menu
            style={float ? floatPlace : place}
            className={cn(
                float ? "fixed" : "absolute",
                "flex flex-col overflow-hidden bg-menu",
                sheet
                    ? "z-0 rounded-t-3xl ps-[max(8px,var(--safe-left))] pe-[max(8px,var(--safe-right))] pt-2 shadow-menu"
                    : cn(
                          "z-50 max-h-[min(378px,45dvh)] rounded-2xl p-2 shadow-dropdown",
                          !float && "inset-x-0",
                          !float && (placement === "below" ? "top-[calc(100%+4px)]" : "bottom-[calc(100%+4px)]"),
                      ),
                (sheet && !place) || (float && !floatPlace) ? "invisible" : undefined,
            )}
        >
            <div
                ref={scroller}
                id={id}
                role="listbox"
                aria-label={label}
                onScroll={updateFade}
                className="min-h-0 flex-1 scroll-pt-7 overflow-y-auto overscroll-contain"
                style={{
                    maskImage:
                        "linear-gradient(to bottom, transparent, var(--mask-solid) var(--fade-top, 0px), var(--mask-solid) calc(100% - var(--fade-bottom, 0px)), transparent)",
                }}
            >
                {sections.map((s, si) =>
                    s.items.length ? (
                        <Fragment key={s.label ?? si}>
                            {s.label && (
                                <div
                                    role="presentation"
                                    className="sticky top-0 z-[1] bg-menu px-2 py-1 text-base leading-5 text-tertiary"
                                >
                                    {s.label}
                                </div>
                            )}
                            <div role="group" aria-label={s.label}>
                                {s.items.map((it) => {
                                    const i = index++;
                                    return (
                                        <Row
                                            key={it.id}
                                            item={it}
                                            id={`${id}-${i}`}
                                            index={i}
                                            active={i === active}
                                            onHover={onHover}
                                            onPick={onPick}
                                            tall={!!sheet}
                                        />
                                    );
                                })}
                            </div>
                        </Fragment>
                    ) : null,
                )}
                {!count && (
                    <div role="status" className="flex min-h-9 items-center px-2 text-base text-tertiary">
                        {status}
                    </div>
                )}
            </div>
            {footer && count > 0 && (
                <div className="shrink-0 px-2 py-[5px] text-base leading-5 text-tertiary">{footer}</div>
            )}
        </div>
    );
    return float ? createPortal(menu, layer ?? document.body) : menu;
}

/**
 * Floating geometry: the menu's edges follow the anchor's viewport rect (composer width, 4px off it, above or
 * below). A "+" menu starts at its button instead. Re-measured on resize, any scroll and when the anchor changes size.
 */
function useFloatPlacement(
    float: { anchor: RefObject<HTMLElement | null>; button?: string } | undefined,
    placement: "above" | "below",
): CSSProperties | undefined {
    const [style, setStyle] = useState<CSSProperties>();
    const anchor = float?.anchor;
    const button = float?.button;
    useLayoutEffect(() => {
        const el = anchor?.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            const b = button ? el.querySelector(button)?.getBoundingClientRect() : undefined;
            const left = b ? Math.max(r.left, b.left - 8) : r.left;
            const next: CSSProperties = { left, width: b ? Math.min(r.right - left, 380) : r.width };
            if (placement === "below") next.top = r.bottom + 4;
            else next.bottom = innerHeight - r.top + 4;
            setStyle((prev) =>
                prev && prev.left === next.left && prev.width === next.width && prev.top === next.top && prev.bottom === next.bottom
                    ? prev
                    : next,
            );
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        addEventListener("resize", update);
        addEventListener("scroll", update, true);
        return () => {
            ro.disconnect();
            removeEventListener("resize", update);
            removeEventListener("scroll", update, true);
        };
    }, [anchor, button, placement]);
    return anchor ? style : undefined;
}

/** Room kept above the sheet: the status bar inset plus a sliver of the page, so it reads as a sheet. */
const SHEET_TOP_GAP = 8;
/** Gap between the last row and the top of the composer. */
const SHEET_COMPOSER_GAP = 6;
/** Tallest list area, so a long command list does not cover a tall screen. */
const SHEET_LIST_MAX = 360;

/**
 * Sheet geometry, measured against the composer: out to both screen edges, down to the bottom of the layout
 * viewport (the keyboard's top edge with interactive-widget=resizes-content), and padded at the bottom by the
 * composer's height, so the rows end above it. Re-measured when the composer grows or the viewport changes.
 */
function useSheetPlacement(anchor: RefObject<HTMLElement | null> | undefined): CSSProperties | undefined {
    const [style, setStyle] = useState<CSSProperties>();
    useLayoutEffect(() => {
        const el = anchor?.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            const height = appHeight();
            const below = height - r.top + SHEET_COMPOSER_GAP;
            setStyle({
                left: -r.left,
                right: -(innerWidth - r.right),
                bottom: -(height - r.bottom),
                paddingBottom: below,
                maxHeight: `min(${below + SHEET_LIST_MAX}px, calc(${height - SHEET_TOP_GAP}px - var(--safe-top)))`,
            });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        addEventListener("resize", update);
        visualViewport?.addEventListener("resize", update);
        return () => {
            ro.disconnect();
            removeEventListener("resize", update);
            visualViewport?.removeEventListener("resize", update);
        };
    }, [anchor]);
    return style;
}
