/**
 * Fluent runtime: the en-GB bundle, built once from the bundled `.ftl` files. There is one locale, so there is no
 * negotiation and no lazy chunk; a missing message shows its id, which `l10n.test.ts` guards against.
 *
 * Non-React code (toasts in event handlers, plain helpers) can call `translate()`.
 */
import { FluentBundle, FluentResource, type FluentVariable } from "@fluent/bundle";
import { ReactLocalization } from "@fluent/react";

export type Vars = Record<string, FluentVariable>;
export type Translate = (id: string, vars?: Vars) => string;

export const SOURCE_LOCALE = "en-GB";

const FILES = import.meta.glob<string>("./en-GB/*.ftl", { eager: true, query: "?raw", import: "default" });

function buildBundle(): FluentBundle {
    const bundle = new FluentBundle(SOURCE_LOCALE, { useIsolating: false });
    for (const [path, source] of Object.entries(FILES)) {
        for (const error of bundle.addResource(new FluentResource(source))) {
            console.warn(`[l10n] ${path}: ${error.message}`);
        }
    }
    return bundle;
}

export const localization = new ReactLocalization([buildBundle()]);

/** Format a message outside React. Prefer `useT()` in components. */
export const translate: Translate = (id, vars) => localization.getString(id, vars);

/** Mark a literal as a message id, for ids kept in maps and chosen at run time. */
export const msg = <T extends string>(id: T): T => id;

/** The locale in use, for `Intl` formatters. There is one. */
export const activeLocalization = () => ({ locale: SOURCE_LOCALE, dir: "ltr" as const });
