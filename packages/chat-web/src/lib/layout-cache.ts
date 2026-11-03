/**
 * Caches the layout state that settings write onto <html> (inline custom properties such as
 * --sidebar-width, --density, --roundness and the motion and font variables, plus the data-* flags
 * density, islands and reducedMotion) so index.html can restore it before first paint. Without it
 * the page renders with stylesheet defaults and shifts once the settings request returns.
 *
 * The settings store stays the source of truth: this is a per-browser snapshot of what was last
 * applied, rewritten every time it changes.
 */

const KEY = "chat.layout";
const DATASET_KEYS = ["density", "islands", "reducedMotion", "blur", "dock"] as const;

export function saveLayoutCache(): void {
    const root = document.documentElement;
    const data: Record<string, string> = {};
    for (const k of DATASET_KEYS) {
        const v = root.dataset[k];
        if (v !== undefined) data[k] = v;
    }
    try {
        localStorage.setItem(KEY, JSON.stringify({ style: root.style.cssText, data }));
    } catch {}
}
