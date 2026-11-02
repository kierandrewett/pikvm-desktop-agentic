/**
 * The frame every destination lives in: navigation plus the one place content is drawn.
 *
 * Phone (coarse pointer or narrow window): a tab bar under the content, above the home
 * indicator, and gone while the soft keyboard is up so it never rides on top of the keys.
 * Wide: a slim rail on the left. The shell sizes itself to the visual viewport and pads for
 * the notch and home indicator, so it reads as an app rather than a page.
 *
 * In the desktop app the window is frameless, so the page is its titlebar. The KVM's toolbar is
 * that titlebar on the KVM; Chat and Settings get a slim one here. The window controls sit over
 * the right end of either.
 */

import { Outlet, useRouterState } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { desktopBridge } from "../host/desktop";
import { activeTab, NavTabs, PANEL_ID, tabDomId } from "./nav";
import { COMPACT_QUERY, useMediaQuery, useViewportFrame } from "./viewport";
import { WindowControls } from "./window-controls";

export function Shell() {
    const compact = useMediaQuery(COMPACT_QUERY);
    const frame = useViewportFrame();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const active = activeTab(pathname);

    const bridge = desktopBridge();
    const titlebar = bridge !== undefined && active !== "kvm";
    const hideBar = compact && frame.keyboardOpen;
    const style = {
        "--app-height": `${frame.height}px`,
        "--app-top": `${frame.top}px`,
        // With the bar hidden the content runs to the screen edge, and the keyboard covers
        // the home indicator, so there is no inset to respect.
    } as CSSProperties;

    return (
        <div
            className="app-shell"
            data-layout={compact ? "compact" : "wide"}
            data-keyboard={frame.keyboardOpen}
            data-desktop={bridge ? (bridge.nativeControls ? "native" : "frameless") : undefined}
            style={style}
        >
            {compact ? null : <NavTabs active={active} orientation="vertical" />}
            <div className="app-main">
                {titlebar ? <div className="window-titlebar">PiKVM Desktop</div> : null}
                <main
                    id={PANEL_ID}
                    className="app-panel"
                    role="tabpanel"
                    aria-labelledby={active ? tabDomId(active) : undefined}
                    tabIndex={-1}
                >
                    <Outlet />
                </main>
            </div>
            {bridge && !bridge.nativeControls ? <WindowControls bridge={bridge} /> : null}
            {compact && !hideBar ? <NavTabs active={active} orientation="horizontal" /> : null}
        </div>
    );
}
