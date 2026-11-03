/**
 * Dev-only switch for the composer surface experiment: `?composer=a|b|c` sets `data-composer-variant` on the
 * root (kept for the tab in sessionStorage so navigation keeps it; `?composer=off` clears it). Production builds
 * drop this. Delete the file once a direction is chosen.
 */
if (import.meta.env.DEV && typeof window !== "undefined") {
    const KEY = "chat.dev.composer-variant";
    const apply = () => {
        const param = new URLSearchParams(location.search).get("composer");
        try {
            if (param === "off") sessionStorage.removeItem(KEY);
            else if (param) sessionStorage.setItem(KEY, param);
        } catch {
            // Private mode: the URL param still applies for this page.
        }
        let v: string | null = param && param !== "off" ? param : null;
        try {
            v ??= sessionStorage.getItem(KEY);
        } catch {
            // ignore
        }
        if (v && /^[abc]$/.test(v)) document.documentElement.dataset.composerVariant = v;
        else delete document.documentElement.dataset.composerVariant;
    };
    apply();
}
export {};
