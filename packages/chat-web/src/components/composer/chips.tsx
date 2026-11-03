/**
 * Composer chips: one model and one look for everything that sits in the text as a single unit.
 *
 * - Attachment markers: "[Pasted text #1]", "[Image #2]", "[File #3]". Pasting long text, an image or a file
 *   inserts one at the caret. The number counts per message (one counter for all kinds) and the marker is the
 *   text the model sees too (see lib/send.ts and the server's ws.ts, which name the file each marker stands for).
 * - "@" mentions (an MCP server or tool, a workspace file) and "/" commands, kept in the composer's `mentions`
 *   list as their literal text, for example "@github/search" or "/review".
 *
 * The editor is a plain textarea, so a chip is text. Three things make it behave as one unit:
 * 1. scanChips() finds the chip ranges in the text. It is the only place that knows what counts as a chip.
 * 2. The composer paints those ranges in a backdrop under the (transparent) textarea text with chipClass().
 *    The backdrop cannot take padding or an icon, because the text must keep the textarea's glyph widths. The
 *    same look with an icon is the <Chip> component (attachment tiles, menus).
 * 3. The caret model below keeps the caret out of chips and makes Backspace and Delete remove a whole chip.
 *    Copying selects text, so a chip copies as its label.
 *
 * Caret model (the same in the textarea and in the full-screen editor, where CodeMirror's atomic ranges do it):
 * - A chip is one unit. ArrowLeft and ArrowRight step over it in one press, in the direction of travel
 *   (stepOverChip, applied on keydown, so the browser never puts the caret inside). Shift+Arrow selects it whole.
 * - Every other motion (word jumps, Home, End, Up, Down, a click) is checked after the browser moved the caret
 *   (snapSelection). Only the end of the selection that moved (the focus) is snapped, in the direction it moved,
 *   so a selection can grow over a chip and shrink back over it. A click goes to the nearer edge.
 * - Removing a chip goes through the browser's editing commands (editTextarea), so Undo and Redo bring it back.
 */
import { At, ClipboardText, FileText, Image as ImageIcon, Terminal } from "@pikvm/icons";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type MarkerKind = "paste" | "image" | "file";
export type ChipKind = MarkerKind | "mention" | "command";

export interface ChipRange {
    start: number;
    end: number;
    kind: ChipKind;
    token: string;
}

const MARKER_LABEL: Record<MarkerKind, string> = { paste: "Pasted text", image: "Image", file: "File" };
const MARKER_PATTERN = /\[(Pasted text|Image|File) #(\d{1,4})\]/g;

/** "[Pasted text #1]" for kind "paste" and number 1. */
export function markerFor(kind: MarkerKind, n: number): string {
    return `[${MARKER_LABEL[kind]} #${n}]`;
}

/** The label without brackets, as screen readers and tooltips use it: "Pasted text #1". */
export function markerLabel(marker: string): string {
    return marker.replace(/^\[|\]$/g, "");
}

export function markerKindOf(marker: string): MarkerKind {
    if (marker.startsWith("[Pasted text")) return "paste";
    return marker.startsWith("[Image") ? "image" : "file";
}

/** The next marker number: one past the highest number used in the text or by a current attachment. */
export function nextMarkerNumber(text: string, markers: readonly string[]): number {
    let max = 0;
    for (const m of text.matchAll(MARKER_PATTERN)) max = Math.max(max, Number(m[2]));
    for (const m of markers) for (const x of m.matchAll(MARKER_PATTERN)) max = Math.max(max, Number(x[2]));
    return max + 1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every chip in `text`, in order. `mentions` are the literal "@" and "/" tokens the composer inserted; `markers`
 * are the attachment markers that still have an attachment, so a marker typed by hand or left over from a
 * restored draft stays plain text.
 */
export function scanChips(text: string, mentions: readonly string[], markers: readonly string[]): ChipRange[] {
    const out: ChipRange[] = [];
    const live = markers.filter((m) => text.includes(m));
    for (const marker of new Set(live)) {
        for (const m of text.matchAll(new RegExp(escapeRe(marker), "g"))) {
            const start = m.index ?? 0;
            out.push({ start, end: start + marker.length, kind: markerKindOf(marker), token: marker });
        }
    }
    const tokens = [...new Set(mentions)].filter((m) => text.includes(m)).sort((a, b) => b.length - a.length);
    if (tokens.length) {
        const re = new RegExp(`(^|\\s)(${tokens.map(escapeRe).join("|")})(?=\\s|$)`, "g");
        for (const m of text.matchAll(re)) {
            const start = (m.index ?? 0) + (m[1]?.length ?? 0);
            const token = m[2] ?? "";
            out.push({ start, end: start + token.length, kind: token.startsWith("/") ? "command" : "mention", token });
        }
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * The span Backspace or Delete at `at` (no selection) removes when it touches a chip, else undefined. With `word`
 * (Ctrl or Alt held) the chip also goes when only spaces lie between it and the caret, as a word would.
 * One space next to the chip goes with it, so removing a chip between two words leaves one space.
 */
export function removeChipAt(
    text: string,
    chips: readonly ChipRange[],
    at: number,
    key: "Backspace" | "Delete",
    word = false,
): { start: number; end: number; chip: ChipRange } | undefined {
    const gap = (from: number, to: number) => from <= to && /^[ \t]*$/.test(text.slice(from, to));
    const chip = chips.find((c) =>
        key === "Backspace"
            ? (at > c.start && at <= c.end) || (word && gap(c.end, at))
            : (at >= c.start && at < c.end) || (word && gap(at, c.start)),
    );
    if (!chip) return undefined;
    // Touching the chip: the chip and one space. Across spaces (a word delete): those spaces and the chip.
    if (key === "Backspace" ? at <= chip.end : at >= chip.start) return { ...chipSpan(text, chip), chip };
    return key === "Backspace" ? { start: chip.start, end: at, chip } : { start: at, end: chip.end, chip };
}

/** The text `chip` takes up, with the one space that goes when it is removed. */
export function chipSpan(text: string, chip: Pick<ChipRange, "start" | "end">): { start: number; end: number } {
    let { start, end } = chip;
    const before = text[start - 1];
    const after = text[end];
    if (after === " " && (start === 0 || before === " " || before === "\n")) end++;
    else if (before === " " && (after === undefined || after === " " || after === "\n")) start--;
    else if (before === " " && after !== undefined) start--;
    return { start, end };
}

/** Text without `chip` and the caret that belongs there. */
export function removeChip(text: string, chip: Pick<ChipRange, "start" | "end">): { text: string; caret: number } {
    const { start, end } = chipSpan(text, chip);
    return { text: text.slice(0, start) + text.slice(end), caret: start };
}

/**
 * `text` with [start, end) replaced by `insert`, and the chip `previous` taken out (one agent per new chat: a second
 * agent chip replaces the first). Returns the caret after the insert, moved back when the removed chip sat before it.
 */
export function replaceWithChip(
    text: string,
    start: number,
    end: number,
    insert: string,
    previous?: string,
): { text: string; caret: number } {
    const out = text.slice(0, start) + insert + text.slice(end);
    let caret = start + insert.length;
    if (!previous || insert.trim() === previous) return { text: out, caret };
    const old = scanChips(out, [previous], []).find((c) => c.token === previous);
    if (!old) return { text: out, caret };
    const removed = removeChip(out, old);
    if (old.start < start) caret -= out.length - removed.text.length;
    return { text: removed.text, caret };
}

/** `text` without the chips whose token is in `tokens`, trimmed. Used to send "@agent" as routing, not as text. */
export function withoutChips(text: string, tokens: readonly string[]): string {
    let out = text;
    for (;;) {
        const hit = scanChips(out, tokens, []).find((c) => tokens.includes(c.token));
        if (!hit) return out.trim();
        out = removeChip(out, hit).text;
    }
}

/** A selection as its fixed end (anchor) and the end that keys move (focus). Collapsed when they are equal. */
export interface Sel {
    anchor: number;
    focus: number;
}

/**
 * How the caret last moved: the key's axis and its direction in the text (1 forward, -1 backward). Up, Down and the
 * page keys are vertical. "other" (a click, a programmatic change) has no direction.
 */
export interface Motion {
    kind: "horizontal" | "vertical" | "other";
    dir: 1 | -1 | 0;
}

const MOTION_KEYS: Record<string, Motion> = {
    ArrowLeft: { kind: "horizontal", dir: -1 },
    ArrowRight: { kind: "horizontal", dir: 1 },
    Home: { kind: "horizontal", dir: -1 },
    End: { kind: "horizontal", dir: 1 },
    ArrowUp: { kind: "vertical", dir: -1 },
    ArrowDown: { kind: "vertical", dir: 1 },
    PageUp: { kind: "vertical", dir: -1 },
    PageDown: { kind: "vertical", dir: 1 },
};
export const NO_MOTION: Motion = { kind: "other", dir: 0 };

/** The motion of a key, with Left and Right swapped in right-to-left text. */
export function motionOf(key: string, rtl = false): Motion {
    const m = MOTION_KEYS[key] ?? NO_MOTION;
    return rtl && m.kind === "horizontal" && key.startsWith("Arrow") ? { ...m, dir: m.dir === 1 ? -1 : 1 } : m;
}

/** A textarea's selection (start, end, direction) as anchor and focus. */
export function selOf(start: number, end: number, direction?: string | null): Sel {
    return direction === "backward" ? { anchor: end, focus: start } : { anchor: start, focus: end };
}

/** Anchor and focus back to the textarea's (start, end, direction). */
export function rangeOf(sel: Sel): [number, number, "forward" | "backward"] {
    return sel.focus < sel.anchor ? [sel.focus, sel.anchor, "backward"] : [sel.anchor, sel.focus, "forward"];
}

/**
 * ArrowLeft or ArrowRight next to a chip: the selection after stepping over the whole chip, or null when no chip is
 * next to the focus in that direction (the browser's own step is right then). `extend` is Shift.
 */
export function stepOverChip(chips: readonly ChipRange[], sel: Sel, forward: boolean, extend: boolean): Sel | null {
    if (!extend && sel.anchor !== sel.focus) return null;
    const chip = chips.find((c) => (forward ? c.start === sel.focus : c.end === sel.focus));
    if (!chip) return null;
    const focus = forward ? chip.end : chip.start;
    return { anchor: extend ? sel.anchor : focus, focus };
}

/**
 * The selection `next` moved out of chips, after `motion` moved it.
 * - The focus inside a chip goes to the edge in the direction of the key, or to the nearer edge (a click or any
 *   other change). A range moved by something other than a key grows to cover the chip.
 * - The anchor inside a chip (a drag, a programmatic change) goes to the edge away from the focus.
 */
export function snapSelection(chips: readonly ChipRange[], next: Sel, motion: Motion): Sel {
    const inside = (p: number) => chips.find((c) => p > c.start && p < c.end);
    let { anchor, focus } = next;
    const collapsed = anchor === focus;
    const fc = inside(focus);
    if (fc) {
        if (motion.dir) focus = motion.dir > 0 ? fc.end : fc.start;
        else if (collapsed) focus = focus - fc.start < fc.end - focus ? fc.start : fc.end;
        else focus = focus > anchor ? fc.end : fc.start;
        if (collapsed) anchor = focus;
    }
    const ac = inside(anchor);
    if (ac) anchor = focus >= anchor ? ac.start : ac.end;
    return { anchor, focus };
}

/**
 * Replace [start, end) in a focused textarea through the browser's editing commands, so the change joins the
 * native Undo and Redo history and fires the usual input event. False when the browser did not do it; the caller
 * then sets the value itself (that change cannot be undone).
 */
export function editTextarea(ed: HTMLTextAreaElement, start: number, end: number, insert: string): boolean {
    if (document.activeElement !== ed || (start === end && !insert)) return false;
    const before = ed.value;
    ed.setSelectionRange(start, end);
    const done = insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete");
    return done && ed.value !== before;
}

const SURFACE =
    "rounded-[calc(6px*var(--roundness))] bg-accent-bg text-accent-text [box-decoration-break:clone] shadow-[0_0_0_1.5px_var(--accent-bg),inset_0_0_0_1px_color-mix(in_srgb,var(--accent-text)_20%,transparent)]";

/** Classes for a chip painted over the textarea's own glyphs (no padding or icon: widths must not change). */
export function chipClass(active = false): string {
    return cn(SURFACE, active && "bg-[color-mix(in_srgb,var(--accent-bg)_70%,var(--accent-text)_30%)]");
}

/** `text` with chips wrapped in marks, for the backdrop under the textarea. Null when there is no chip. */
export function paintChips(
    text: string,
    chips: readonly ChipRange[],
    selection?: readonly [number, number],
): ReactNode[] | null {
    if (!chips.length) return null;
    const out: ReactNode[] = [];
    let last = 0;
    for (const c of chips) {
        if (c.start < last) continue;
        out.push(text.slice(last, c.start));
        const selected =
            !!selection && selection[0] <= c.start && selection[1] >= c.end && selection[0] !== selection[1];
        out.push(
            <mark key={c.start} data-chip={c.kind} className={chipClass(selected)}>
                {c.token}
            </mark>,
        );
        last = c.end;
    }
    out.push(text.slice(last));
    return out;
}

/** The chip surface around a menu row's own icon: the "@" and "/" rows share the look of the chips they insert. */
export function ChipGlyph({
    kind,
    active = false,
    children,
}: {
    kind: ChipKind;
    active?: boolean;
    children: ReactNode;
}) {
    return (
        <span
            data-chip={kind}
            className={cn(chipClass(active), "flex size-6 shrink-0 items-center justify-center [&_svg]:size-4")}
        >
            {children}
        </span>
    );
}

const KIND_ICON = { paste: ClipboardText, image: ImageIcon, file: FileText, mention: At, command: Terminal } as const;

/** The chip with its icon: attachment tiles and menus. Icons are regular weight, filled when active. */
export function Chip({
    kind,
    label,
    active = false,
    className,
}: {
    kind: ChipKind;
    label: string;
    active?: boolean;
    className?: string;
}) {
    const Icon = KIND_ICON[kind];
    return (
        <span
            data-chip={kind}
            className={cn(
                SURFACE,
                "inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 text-sm leading-4 font-medium",
                className,
            )}
        >
            <Icon weight={active ? "fill" : "regular"} aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
        </span>
    );
}
