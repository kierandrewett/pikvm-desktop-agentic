/**
 * Chat is most of the app's weight (markdown, tool cards, the provider forms) and the KVM and
 * Settings never need it, so its code loads when Chat is first opened, or earlier when the pointer
 * or focus reaches its tab. Once loaded and mounted it stays mounted (see panes.tsx).
 */

import { lazy, Suspense } from "react";

const load = () => import("../chat/chat-route");

/** Start fetching Chat's code without showing it. */
export function preloadChat(): void {
    void load();
}

const ChatRoute = lazy(() => load().then((module) => ({ default: module.ChatRoute })));

/** `active`: Chat is the tab in front. */
export function ChatPane({ active }: { active: boolean }) {
    return (
        <Suspense fallback={<div className="empty-state" role="status" aria-label="Loading" />}>
            <ChatRoute active={active} />
        </Suspense>
    );
}
