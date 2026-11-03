import type { Plugin } from "vite";

/**
 * Tailwind writes the theme variables a stylesheet uses on `:root, :host`. For the conversation pane's stylesheet
 * (packages/chat-web/src/styles/chat.css) that would redefine the app's own `--font-sans` and `--radius-*` for the
 * whole page, so its theme block is moved onto `.chat-scope`, where everything else of the pane already is.
 *
 * The pane's sheet is recognised by what only it declares: `--font-sans` pointing at the pane's own `--font-ui`. The
 * app's sheet has a theme block too, and keeps it at the root. The built CSS is checked by e2e/chat-integration.
 */
export const CHAT_THEME_MARKER = "--font-sans:var(--font-ui)";

/** The theme block of Tailwind's output, whether plain CSS (a build's asset) or inside a JS string (the dev server). */
export function scopeTheme(css: string): string {
    if (!css.replaceAll(/\s|\\n/g, "").includes(CHAT_THEME_MARKER)) return css;
    return css.replace(/(@layer theme\s*\{(?:\s|\\n)*):root,(?:\s|\\n)*:host/g, "$1.chat-scope");
}

export function scopeChatTheme(): Plugin {
    return {
        name: "pikvm:scope-chat-theme",
        enforce: "post",
        transform(code, id) {
            if (!id.includes("/chat-web/") || !id.endsWith(".css")) return;
            const scoped = scopeTheme(code);
            return scoped === code ? undefined : { code: scoped, map: null };
        },
        generateBundle(_options, bundle) {
            for (const file of Object.values(bundle)) {
                if (file.type !== "asset" || !file.fileName.endsWith(".css") || typeof file.source !== "string") continue;
                file.source = scopeTheme(file.source);
            }
        },
    };
}
