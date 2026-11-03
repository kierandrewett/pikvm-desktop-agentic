/**
 * Recency groups for the Chats section: Today, Yesterday, Previous 7 days, Previous 30 days, then one
 * group per month ("September", or "September 2025" for earlier years). Input must be sorted newest first.
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { activeLocalization, translate } from "../../l10n/runtime";

export interface DateGroup {
    id: string;
    label: string;
    items: ConversationSummary[];
}

const DAY = 86_400_000;

/** Names that depend on the active locale. Rebuilt when the locale changes. */
interface Names {
    locale: string;
    month: Intl.DateTimeFormat;
    today: string;
    yesterday: string;
    days7: string;
    days30: string;
    months: Map<number, string>;
    fixed: DateBucket[];
}

let names: Names | undefined;

function localeNames(): Names {
    const { locale } = activeLocalization();
    if (names?.locale === locale) return names;
    // Today and Yesterday come from Intl, so each locale uses its own word. Intl returns them in lower case.
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const upper = (text: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
    names = {
        locale,
        month: new Intl.DateTimeFormat(locale, { month: "long" }),
        today: upper(relative.format(0, "day")),
        yesterday: upper(relative.format(-1, "day")),
        days7: translate("sidebar-group-previous-days", { count: 7 }),
        days30: translate("sidebar-group-previous-days", { count: 30 }),
        months: new Map(),
        fixed: [],
    };
    names.fixed = FIXED_BUCKETS.map((b, i) => ({
        ...b,
        label: [names!.today, names!.yesterday, names!.days7, names!.days30][i]!,
    }));
    return names;
}

function monthLabel(d: Date, now: Date): string {
    const month = localeNames().month.format(d);
    return d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

export function groupByDate(list: readonly ConversationSummary[], now = new Date()): DateGroup[] {
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const n = localeNames();
    const bounds: [string, string, number][] = [
        ["today", n.today, startToday],
        ["yesterday", n.yesterday, startToday - DAY],
        ["7d", n.days7, startToday - 7 * DAY],
        ["30d", n.days30, startToday - 30 * DAY],
    ];
    const groups: DateGroup[] = [];
    let current: DateGroup | undefined;
    for (const c of list) {
        let id: string;
        let label: string;
        const fixed = bounds.find(([, , start]) => c.updatedAt >= start);
        if (fixed) {
            [id, label] = fixed;
        } else {
            const d = new Date(c.updatedAt);
            id = `${d.getFullYear()}-${d.getMonth()}`;
            // Formatting a month name is slow; with thousands of chats, format each month once.
            label = current?.id === id ? current.label : monthLabel(d, now);
        }
        if (current?.id !== id) {
            current = { id, label, items: [] };
            groups.push(current);
        }
        current.items.push(c);
    }
    return groups;
}

/** A date bucket: Today, Yesterday, Previous 7 days, Previous 30 days, then months of this year, then years. */
export interface DateBucket {
    id: string;
    label: string;
    /** Smaller is more recent. */
    rank: number;
}

const FIXED_BUCKETS = [
    { id: "today", rank: 0 },
    { id: "yesterday", rank: 1 },
    { id: "7d", rank: 2 },
    { id: "30d", rank: 3 },
] as const;

const fixedBucket = (index: number): DateBucket => localeNames().fixed[index]!;

/**
 * The bucket for a time. Months are named for the current year; earlier years are one bucket each ("2025"). The
 * Chats section's default view used to name every month with its year; years replace that past the current one.
 */
export function dateBucket(ts: number, now: Date, startToday: number): DateBucket {
    if (ts >= startToday) return fixedBucket(0);
    if (ts >= startToday - DAY) return fixedBucket(1);
    if (ts >= startToday - 7 * DAY) return fixedBucket(2);
    if (ts >= startToday - 30 * DAY) return fixedBucket(3);
    const d = new Date(ts);
    const year = d.getFullYear();
    if (year === now.getFullYear()) {
        const key = d.getMonth();
        const { months, month } = localeNames();
        let label = months.get(key);
        if (!label) months.set(key, (label = month.format(d)));
        return { id: `m-${year}-${key}`, label, rank: 4 + (11 - key) };
    }
    return { id: `y-${year}`, label: String(year), rank: 100 + (now.getFullYear() - year) };
}

export const startOfToday = (now: Date): number => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
