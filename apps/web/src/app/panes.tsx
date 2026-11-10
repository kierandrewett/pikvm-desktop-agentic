/**
 * The four destinations as panes that stay put.
 *
 * Each pane is drawn once it has been visited (the KVM from the start, so its picture and link
 * are live before the user ever opens it) and is never unmounted afterwards: a tab change hides
 * one and shows another. The routes decide WHICH pane is in front; they do not create or destroy
 * them, which is what keeps the stream, the draft and the open settings page alive.
 *
 * A hidden pane is laid out exactly as before (visibility, not display), so the video keeps its
 * size and a returning screen needs no re-measuring, but it is `inert` and `aria-hidden`: it takes
 * no focus, pointer or keyboard input and is not announced. Its own code is told it is hidden
 * where that matters (the KVM listens on the document, see kvm/active.ts).
 */

import type { ReactNode } from "react";
import { panelDomId, tabDomId, type TabId } from "./nav";

interface PaneProps {
    readonly id: TabId;
    readonly active: boolean;
    readonly children?: ReactNode;
}

export function Pane({ id, active, children }: PaneProps) {
    return (
        <div
            id={panelDomId(id)}
            role="tabpanel"
            aria-labelledby={tabDomId(id)}
            className="app-pane"
            data-active={active}
            inert={!active}
            aria-hidden={active ? undefined : true}
        >
            {children}
        </div>
    );
}
