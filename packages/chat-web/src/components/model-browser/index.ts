/**
 * Model browser: a searchable, filterable, virtualised model list with a vendor or provider rail, per-row host
 * controls, bulk actions and an optional detail pane. See model-browser.tsx for the layout and keyboard contract.
 */
export {
    ModelBrowser,
    type DetailContext,
    type FavoritesBinding,
    type ModelBrowserProps,
    type ModelBrowserSelection,
    type PinnedEntry,
} from "./model-browser";
export { DetailHeader, ModelFacts, metaLine, type BulkAction, type RowContext } from "./parts";
export {
    buildIndex,
    capabilityFilters,
    filterLabelIds,
    highlightRanges,
    queryTerms,
    rankEntries,
    type BrowserFilter,
    type ModelRowState,
} from "./search";
