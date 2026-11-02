/**
 * Feedback on iOS, which has no navigator.vibrate: web-haptics (haptics.lochie.me) rides the
 * Taptic engine through a hidden `<input switch>`. Elsewhere the pointer DOM sink already
 * vibrates, so this does nothing there rather than buzzing twice. Loaded on first use, and every
 * call is a no-op until it has loaded and on devices that cannot.
 */

interface Haptics {
    trigger(kind?: string): unknown;
}

let instance: Haptics | null = null;
let loading = false;

export function buzz(kind: "light" | "medium" = "light"): void {
    if (typeof navigator === "undefined" || typeof navigator.vibrate === "function") return;
    if (instance) {
        try {
            void instance.trigger(kind);
        } catch {
            // A device that cannot do it is not worth an error.
        }
        return;
    }
    if (loading) return;
    loading = true;
    import("web-haptics").then(
        (module) => {
            try {
                instance = new module.WebHaptics();
            } catch {
                // no haptics here
            }
        },
        () => {},
    );
}
