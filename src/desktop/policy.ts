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

/**
 * Whether a bridge call came from the page the user chose: the top frame, at exactly the app's origin.
 * An iframe inside it, or a page it navigated to, is refused.
 */
export function trustedFrame(appOrigin: string, frame: { readonly url: string; readonly hasParent: boolean } | null): boolean {
    if (!frame || frame.hasParent) return false;
    const here = parse(frame.url);
    return here !== null && here.origin === appOrigin;
}

export interface FitRequest {
    readonly width: number;
    readonly height: number;
    readonly chromeWidth: number;
    readonly chromeHeight: number;
}

/**
 * The window content size that shows the picture 1:1. The chrome around the picture is fixed-pixel, so
 * only the picture shrinks, and only as far as the work area needs. Null when the request is not a
 * usable size.
 */
export function fitContentSize(
    request: FitRequest,
    workArea: { readonly width: number; readonly height: number },
    minimum: { readonly width: number; readonly height: number },
): { width: number; height: number } | null {
    const { width, height } = request;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    const chromeW = Math.max(0, Math.round(Number(request.chromeWidth) || 0));
    const chromeH = Math.max(0, Math.round(Number(request.chromeHeight) || 0));
    const scale = Math.min(
        1,
        Math.max(320, workArea.width - chromeW) / width,
        Math.max(240, workArea.height - chromeH) / height,
    );
    return {
        // The window minimum never pushes the window past the work area, or the picture would be cropped.
        width: Math.min(workArea.width, Math.max(minimum.width, Math.round(width * scale) + chromeW)),
        height: Math.min(workArea.height, Math.max(minimum.height, Math.round(height * scale) + chromeH)),
    };
}
