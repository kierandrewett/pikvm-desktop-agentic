/**
 * The height the app is laid out in, in px: the host's `--app-height` (the shell), not `innerHeight`.
 *
 * The host's shell is `100dvh` (in the installed app, plus the top inset) while the soft keyboard is closed; while
 * it is up the host writes the visual viewport's height there, so this is the area above the keys then, and
 * anything placed from it (a sheet's bottom edge, a popover's flip point) follows the shell. Measured with a probe
 * element rather than parsed, because the value is a length (`100dvh`, `735px`), not a number. Without a host the
 * variable is unset and the probe is `100dvh`.
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
