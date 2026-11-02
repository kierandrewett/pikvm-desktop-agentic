/** What the window may navigate to, and what it may hand to the OS. No Electron here, so it is unit-tested. */

/** Schemes the page may ask the OS to open. Anything else (file:, javascript:, custom handlers) is refused. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export type NavigationVerdict = "allow" | "external" | "block";

function parse(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

/** The URL normalised for the OS, or null when it is not one we open. */
export function externalUrl(url: string): string | null {
    const parsed = parse(url);
    return parsed && EXTERNAL_SCHEMES.has(parsed.protocol) ? parsed.toString() : null;
}

/**
 * The page stays on the app's own origin. The kvmd passthrough shares that origin, but its `/api/`
 * answers JSON and downloads, never a page, so a navigation there goes to the browser as before.
 */
export function navigationVerdict(appOrigin: string, target: string): NavigationVerdict {
    const to = parse(target);
    if (!to) return "block";
    const here = parse(appOrigin);
    if (here && to.origin === here.origin && !to.pathname.startsWith("/api/")) return "allow";
    return externalUrl(target) ? "external" : "block";
}
