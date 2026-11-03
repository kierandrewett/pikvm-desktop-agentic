/**
 * Block-level markdown components: tables (scroll with edge fades, sticky header when tall, copy as
 * Markdown or CSV), GFM alerts, headings with hover anchors and in-page anchor links (footnotes, headings)
 * that scroll inside the thread instead of changing the route.
 */
import {
    CheckIcon,
    CopyIcon,
    InfoIcon,
    LightbulbIcon,
    LinkSimpleIcon,
    WarningCircleIcon,
    WarningDiamondIcon,
    WarningIcon,
    type Icon,
} from "@pikvm/icons";
import { memo, type MouseEvent, type ReactNode } from "react";
import { Button } from "../../ui/button";
import { Menu } from "../../ui/menu";
import { useCopy } from "./env";
import { hastText, type HastNode } from "./syntax";
import { motionMs } from "../../../lib/motion";

// Tables

/** Rows above which the table gets a max height with a sticky header. */
const TALL_ROWS = 12;

function rowsOf(table: HastNode | undefined): HastNode[] {
    const out: HastNode[] = [];
    const walk = (n: HastNode) => {
        if (n.tagName === "tr") out.push(n);
        else for (const c of n.children ?? []) if (c.type === "element") walk(c);
    };
    if (table) walk(table);
    return out;
}

const cellsOf = (tr: HastNode) => (tr.children ?? []).filter((c) => c.tagName === "td" || c.tagName === "th");

export function tableToMarkdown(table: HastNode | undefined): string {
    const rows = rowsOf(table);
    if (!rows.length) return "";
    const head = cellsOf(rows[0]!);
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const align = head.map((c) => {
        const a = c.properties?.align ?? (c.properties?.style as string | undefined)?.match(/text-align:\s*(\w+)/)?.[1];
        return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    });
    return [
        line(head.map((c) => esc(hastText(c)))),
        line(align),
        ...rows.slice(1).map((r) => line(cellsOf(r).map((c) => esc(hastText(c))))),
    ].join("\n");
}

export function tableToCsv(table: HastNode | undefined): string {
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return rowsOf(table)
        .map((r) =>
            cellsOf(r)
                .map((c) => q(hastText(c).trim()))
                .join(","),
        )
        .join("\n");
}

function TableCopy({ node }: { node: HastNode | undefined }) {
    const [copied, copy] = useCopy();
    return (
        <Menu
            align="end"
            title="Copy table"
            trigger={
                <Button size="sm" uniform pill aria-label={copied ? "Copied" : "Copy table"} className="[--icon:16px]">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </Button>
            }
            items={[
                { label: "Copy as Markdown", onSelect: () => copy(tableToMarkdown(node)) },
                { label: "Copy as CSV", onSelect: () => copy(tableToCsv(node)) },
            ]}
        />
    );
}

export const Table = memo(function Table({ node, children }: { node: HastNode | undefined; children: ReactNode }) {
    const tall = rowsOf(node).length > TALL_ROWS;
    return (
        <div className="md-table">
            <div className="md-table-tools">
                <TableCopy node={node} />
            </div>
            <div className="md-table-scroll" data-no-drawer-gesture="" data-tall={tall || undefined} tabIndex={0}>
                <table>{children}</table>
            </div>
        </div>
    );
});

// Alerts

const ALERTS: Record<string, { label: string; icon: Icon }> = {
    note: { label: "Note", icon: InfoIcon },
    tip: { label: "Tip", icon: LightbulbIcon },
    important: { label: "Important", icon: WarningDiamondIcon },
    warning: { label: "Warning", icon: WarningIcon },
    caution: { label: "Caution", icon: WarningCircleIcon },
};

export function Alert({ kind, children }: { kind: string; children: ReactNode }) {
    const a = ALERTS[kind] ?? ALERTS.note!;
    const Glyph = a.icon;
    return (
        <div className="md-alert" data-alert={kind} role="note" aria-label={a.label}>
            <div className="md-alert-title">
                <Glyph aria-hidden size={18} weight="fill" />
                {a.label}
            </div>
            {children}
        </div>
    );
}

// Anchors

/** Scroll to an in-page target inside the thread, move focus to it and flash it briefly. */
export function scrollToAnchor(e: MouseEvent<HTMLAnchorElement>, hash: string): void {
    let id: string;
    try {
        id = decodeURIComponent(hash.slice(1));
    } catch {
        return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ block: "center", behavior: motionMs(150) ? "smooth" : "instant" });
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    target.classList.remove("md-flash");
    void target.offsetWidth;
    target.classList.add("md-flash");
    history.replaceState(history.state, "", `#${id}`);
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export function Heading({ as: Tag, id, children }: { as: HeadingTag; id?: string; children: ReactNode }) {
    return (
        <Tag id={id} className="md-heading">
            {children}
            {id && (
                <a
                    href={`#${id}`}
                    className="md-anchor"
                    aria-label="Link to this section"
                    onClick={(e) => scrollToAnchor(e, `#${id}`)}
                >
                    <LinkSimpleIcon aria-hidden size={16} />
                </a>
            )}
        </Tag>
    );
}
