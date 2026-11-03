/**
 * Settings search hooks of the kit. Chat's own app has a results page that renders every settings page inside a
 * search scope; the Chat pane's pages are few and always render whole, so no scope is ever provided and these hooks
 * say "show everything, mark nothing". The kit components still call them so pages stay the same as upstream.
 */
import type { ReactNode } from "react";

export interface SearchScope {
    /** Slug of the page being rendered. */
    slug: string;
}

/** The search scope, or null: there is no settings search in the Chat pane. */
export const useSearchScope = (): SearchScope | null => null;

/** Rows and sections always show. */
export const useRowSearch = (_id: string | undefined): "show" | "hit" | "hidden" => "show";
export const useSectionSearch = (_title: ReactNode): { revealed: boolean } | null => null;
export const useHideEmpty = (): boolean => false;

export const hideWithoutHits = "not-has-[[data-search-hit]]:hidden";

/** Passes its children through: nothing marks a query. */
export function SectionReveal({ children }: { value: boolean; children: ReactNode }) {
    return <>{children}</>;
}

/** A string, unmarked. */
export const SearchMark = ({ text }: { text: string }) => text;

export const markText = (node: ReactNode): ReactNode => node;
