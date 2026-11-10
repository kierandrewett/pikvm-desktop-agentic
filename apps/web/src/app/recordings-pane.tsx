/**
 * Recordings is its own destination, and loads when it is first opened (or when the pointer or focus reaches its tab), like Chat:
 * the library, the player and the transcript are not needed by anyone who never opens it. Once mounted it stays mounted (panes.tsx).
 */

import { lazy, Suspense } from "react";

const load = () => import("../recordings/recordings-route");

/** Start fetching the page's code without showing it. */
export function preloadRecordings(): void {
    void load();
}

const RecordingsRoute = lazy(() => load().then((module) => ({ default: module.RecordingsRoute })));

/** `active`: Recordings is the tab in front. */
export function RecordingsPane({ active }: { active: boolean }) {
    return (
        <Suspense fallback={<div className="empty-state" role="status" aria-label="Loading" />}>
            <RecordingsRoute active={active} />
        </Suspense>
    );
}
