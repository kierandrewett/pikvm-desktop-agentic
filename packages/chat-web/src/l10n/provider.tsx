/**
 * React side of localisation: one provider over the bundled en-GB bundle, and the hooks components use.
 *
 *     const t = useT();
 *     <button aria-label={t("sidebar-account-menu-label", { name })}>...</button>
 *
 * For a sentence with an element inside it, use `Localized` with `elems`.
 */
import { LocalizationProvider } from "@fluent/react";
import type { ReactNode } from "react";
import "./registry-text";
import { localization, translate, type Translate } from "./runtime";

export function L10nProvider({ children }: { children: ReactNode }) {
    return <LocalizationProvider l10n={localization}>{children}</LocalizationProvider>;
}

/** Format a message. The function is stable: there is one locale. */
export function useT(): Translate {
    return translate;
}

/** The active locale and direction, for `Intl` formatters. */
export function useLocale(): { locale: string; dir: "ltr" | "rtl" } {
    return { locale: "en-GB", dir: "ltr" };
}

export { Localized } from "@fluent/react";
