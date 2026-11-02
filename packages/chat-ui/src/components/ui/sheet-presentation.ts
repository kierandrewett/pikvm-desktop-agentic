/**
 * How a popover-style control (select, menu) presents itself on a phone: as a bottom
 * sheet. A popover anchored to a trigger near the screen edge is cramped, hides under
 * the keyboard and has targets sized for a mouse; a sheet is reachable with a thumb and
 * can have rows 48px tall.
 *
 * The primitives position their popup with inline styles from the anchor, so the sheet
 * overrides them with important utilities instead of forking the primitives and losing
 * their keyboard handling, typeahead and focus management.
 */

export const SHEET_POSITIONER =
    "fixed! inset-x-0! bottom-0! top-auto! left-0! right-0! z-50 w-full! max-w-none! translate-x-0! translate-y-0! transform-none!";

export const SHEET_POPUP =
    "w-full! min-w-0! max-h-[min(70dvh,32rem)]! rounded-b-none! rounded-t-2xl! p-1.5 pb-[calc(0.5rem+var(--chat-safe-bottom,0px))] ring-0! border-t shadow-2xl";

export const SHEET_BACKDROP = "fixed inset-0 z-50 bg-black/45";

/** Rows on a sheet are at least 48px: one thumb, no precision needed. */
export const SHEET_ITEM = "min-h-12! rounded-lg! px-3! py-2.5! text-[15px]!";
