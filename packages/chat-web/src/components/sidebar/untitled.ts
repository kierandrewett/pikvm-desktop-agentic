/**
 * The title shown for a chat that has none yet. Sorting and filtering call this for every chat in a long list, so
 * the translated text is cached until the active locale changes.
 */
import { activeLocalization, translate } from "../../l10n/runtime";

let cached: { source: object; text: string } | undefined;

export function untitledChat(): string {
    const source = activeLocalization();
    if (cached?.source !== source) cached = { source, text: translate("sidebar-untitled-chat") };
    return cached.text;
}

/** The chat's title, or the untitled text. */
export const chatTitle = (c: { title: string }): string => c.title || untitledChat();
