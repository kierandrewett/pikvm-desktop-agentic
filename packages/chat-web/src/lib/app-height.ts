/**
 * The height the app is laid out in, in px: the host's `--app-height` (the shell), not `innerHeight`.
 *
 * In the installed phone app `innerHeight` and the visual viewport report the screen minus an inset when the
 * app starts, while the shell is the whole screen (100vh); anything placed from `innerHeight` (a sheet's
 * bottom edge, a popover's flip point) lands that far too high. While the soft keyboard is up the host
 * writes the visual viewport's height there, so this is the area above the keys then. Measured with a probe
 * element rather than parsed, because the value is a length (`100vh`, `100dvh`, `735px`), not a number.
 * Without a host the variable is unset and the probe is `100dvh`, which is `innerHeight` for this purpose.
 */

let probe: HTMLElement | undefined;

export function appHeight(): number {
    if (!probe?.isConnected) {
        probe = document.createElement("div");
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:var(--app-height,100dvh);visibility:hidden;pointer-events:none";
        document.body.append(probe);
    }
    const height = probe.getBoundingClientRect().height;
    return height > 0 ? height : innerHeight;
}
