import { useEffect } from "react";
import type { TabId } from "../app/nav";
import { badgeController, isPushBadgeMessage } from "./app-badge";

/**
 * Keeps the icon badge honest while the app is open (the shell calls this with the tab in front): what the person has
 * now seen is cleared when the app is in front on the tab it was about, and the service worker's word of a screen
 * push reaches the badge count. Where there is no service worker or no Badging API it does nothing.
 */
export function useAppBadge(tab: TabId | undefined): void {
    useEffect(() => {
        badgeController.tab(tab);
    }, [tab]);

    useEffect(() => {
        void badgeController.start();
        const reconcile = (): void => badgeController.reconcile();
        document.addEventListener("visibilitychange", reconcile);
        window.addEventListener("pageshow", reconcile);
        window.addEventListener("focus", reconcile);
        // A container that cannot take listeners (a stub, an old engine) is as good as none.
        const container = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
        const worker = typeof container?.addEventListener === "function" ? container : undefined;
        const onMessage = (event: MessageEvent<unknown>): void => {
            if (isPushBadgeMessage(event.data)) badgeController.screenPush(event.data.count);
        };
        worker?.addEventListener("message", onMessage);
        return () => {
            document.removeEventListener("visibilitychange", reconcile);
            window.removeEventListener("pageshow", reconcile);
            window.removeEventListener("focus", reconcile);
            worker?.removeEventListener("message", onMessage);
        };
    }, []);
}
