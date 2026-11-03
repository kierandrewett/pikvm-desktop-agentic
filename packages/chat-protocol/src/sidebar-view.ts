/**
 * Sidebar section views: how Pinned, Projects and Chats sort, group, filter and limit their rows.
 *
 * One structured setting, `ui.sidebar.sections`, holds the choices for all three sections. Stored values are
 * partial: a field that is missing means the section's default (sidebarViewDefaults), so a change to a default
 * reaches everyone who never touched it, and "Reset view" deletes the section's entry.
 *
 * Expanded rows are a separate setting (`ui.sidebar.expandedRows`) and do not belong in a view: they apply to
 * every section and have nothing to do with `ui.density`, which scales the padding of both row styles.
 */
import { z } from "zod";

export const sidebarSectionIds = ["pinned", "projects", "chats"] as const;
export type SidebarSectionId = (typeof sidebarSectionIds)[number];

/**
 * - activity: last activity (`updatedAt`); created: `createdAt`; title: alphabetical
 * - pinned: the time the chat was pinned (Pinned only)
 * - manual: the order the user dragged or moved rows into (Pinned and Projects)
 * - count: number of chats in a project (Projects only)
 */
export const sidebarSorts = ["activity", "created", "title", "pinned", "manual", "count"] as const;
export const sidebarGroups = ["none", "date", "project", "model"] as const;
export const sidebarRanges = ["any", "day", "week", "month", "year"] as const;
/** Rows shown before "Show more"; 0 shows all. */
export const sidebarLimits = [5, 10, 0] as const;

export const SidebarFilter = z.object({
    /** Only chats that carried an image or an uploaded file. */
    attachments: z.boolean(),
    /** Model ids (`provider/model`). Empty means every model. */
    models: z.array(z.string().max(200)).max(100),
    /** Last activity within this window. */
    range: z.enum(sidebarRanges),
    /** Custom agent ids. Empty means every chat. */
    agents: z.array(z.string().max(100)).max(100),
});
export type SidebarFilter = z.infer<typeof SidebarFilter>;

export const SidebarSectionView = z.object({
    sort: z.enum(sidebarSorts),
    direction: z.enum(["asc", "desc"]),
    group: z.enum(sidebarGroups),
    filter: SidebarFilter,
    limit: z.union([z.literal(5), z.literal(10), z.literal(0)]),
    /** The section body is hidden. Its header stays, with the menu, so the section can come back. */
    hidden: z.boolean(),
    /** Ids in manual order (chat ids for Pinned, project ids for Projects). Unlisted ids follow, in default order. */
    manual: z.array(z.string().max(100)).max(5000),
});
export type SidebarSectionView = z.infer<typeof SidebarSectionView>;

/** What is stored for one section: any field may be missing, including inside `filter`. */
export const StoredSidebarSectionView = SidebarSectionView.partial().extend({
    filter: SidebarFilter.partial().optional(),
});
export type StoredSidebarSectionView = z.infer<typeof StoredSidebarSectionView>;

export const SidebarSections = z
    .object({
        pinned: StoredSidebarSectionView.optional(),
        projects: StoredSidebarSectionView.optional(),
        chats: StoredSidebarSectionView.optional(),
    })
    .strict();
export type SidebarSections = z.infer<typeof SidebarSections>;

export const noSidebarFilter: SidebarFilter = { attachments: false, models: [], range: "any", agents: [] };

/**
 * Defaults per section, matching what the sidebar did before views existed: Pinned by pin time, newest first;
 * Projects by name; Chats by last activity with date groups.
 */
export const sidebarViewDefaults: Record<SidebarSectionId, SidebarSectionView> = {
    pinned: {
        sort: "pinned",
        direction: "desc",
        group: "none",
        filter: noSidebarFilter,
        limit: 0,
        hidden: false,
        manual: [],
    },
    projects: {
        sort: "title",
        direction: "asc",
        group: "none",
        filter: noSidebarFilter,
        limit: 0,
        hidden: false,
        manual: [],
    },
    chats: {
        sort: "activity",
        direction: "desc",
        group: "date",
        filter: noSidebarFilter,
        limit: 0,
        hidden: false,
        manual: [],
    },
};

/** Sorts a section offers, in menu order. */
export const sidebarSortsFor: Record<SidebarSectionId, readonly (typeof sidebarSorts)[number][]> = {
    pinned: ["pinned", "activity", "created", "title", "manual"],
    projects: ["title", "activity", "created", "count", "manual"],
    chats: ["activity", "created", "title"],
};

/** Groupings a section offers. Projects are folders already, and chats in a project cannot be loose Chats. */
export const sidebarGroupsFor: Record<SidebarSectionId, readonly (typeof sidebarGroups)[number][]> = {
    pinned: ["none", "date", "project", "model"],
    projects: ["none"],
    chats: ["none", "date", "model"],
};

/** The default direction a sort starts in: text and manual order ascend, times and counts descend. */
export const sidebarDirectionFor = (sort: (typeof sidebarSorts)[number]): "asc" | "desc" =>
    sort === "title" || sort === "manual" ? "asc" : "desc";
