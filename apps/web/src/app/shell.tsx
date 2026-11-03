/**
 * The frame every destination lives in: navigation plus the one place content is drawn.
 *
 * Phone (coarse pointer or narrow window): a tab bar under the content that runs to the bottom
 * edge, its own padding covering the home indicator, and gone while the soft keyboard is up so it
 * never rides on top of the keys. Wide: a slim rail on the left. The shell sizes itself to the
 * visual viewport and pads for the status bar (painted black, styles.css) so it reads as an app
 * rather than a page.
 *
 * The destinations are panes that stay mounted (see panes.tsx); the URL says which one is in
 * front. Settings also remembers the page that was open, so its tab returns there.
 *
 * In the desktop app the window is frameless, so the page is its titlebar. The KVM's toolbar is
 * that titlebar on the KVM; Chat and Settings get a slim one here. The window controls sit over
 * the right end of either.
 */

import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useLayoutEffect, useState } from "react";
import { AgentActivityProvider } from "../agent/activity";
import { useAppState } from "../api/queries";
import { KvmPane } from "../kvm/kvm-screen";
import { SettingsPane, settingsPageOf } from "../settings/settings-layout";
import { desktopBridge } from "../host/desktop";
import { ChatPane } from "./chat-pane";
import { activeTab, NavTabs, type TabId } from "./nav";
import { Pane } from "./panes";
import { COMPACT_QUERY, useMediaQuery, useViewportFrame } from "./viewport";
import { WindowControls } from "./window-controls";

export function Shell() {
    const compact = useMediaQuery(COMPACT_QUERY);
    const frame = useViewportFrame();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const active = activeTab(pathname);
    // What the agent is doing is streamed while the host has a chat server; the KVM and the tab bar both show it.
    const agentStream = useAppState().data?.features.chat === true;

    // Mounted from the first time it is in front, and never unmounted. The KVM is in from the start.
    const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(["kvm"]));
    if (active !== undefined && !visited.has(active)) setVisited(new Set(visited).add(active));

    // The Settings page open now, or the one left open while another tab is in front.
    const [leftOpen, setLeftOpen] = useState<string | undefined>(undefined);
    const onSettings = active === "settings";
    const settingsPage = onSettings ? settingsPageOf(pathname) : leftOpen;
    if (onSettings && leftOpen !== settingsPage) setLeftOpen(settingsPage);

    const bridge = desktopBridge();
    const titlebar = bridge !== undefined && active !== "kvm";
    const hideBar = compact && frame.keyboardOpen;
    // The status-bar strip is on <html> (styles.css) so it sits over full-page sheets too; it needs the
    // same offset as the shell when iOS pans the visual viewport for the keyboard, so both read it
    // from the root. (With the bar hidden the content runs to the screen edge, and the keyboard
    // covers the home indicator, so there is no bottom inset to respect.)
    useLayoutEffect(() => {
        const root = document.documentElement;
        root.style.setProperty("--app-top", `${frame.top}px`);
        return () => {
            root.style.removeProperty("--app-top");
        };
    }, [frame.top]);
    const style = { "--app-height": `${frame.height}px` } as CSSProperties;

    return (
        <AgentActivityProvider enabled={agentStream}>
            <div
                className="app-shell"
                data-layout={compact ? "compact" : "wide"}
                data-keyboard={frame.keyboardOpen}
                data-tab={active}
                data-desktop={bridge ? (bridge.nativeControls ? "native" : "frameless") : undefined}
                style={style}
            >
                {compact ? null : <NavTabs active={active} orientation="vertical" settingsPage={settingsPage} />}
                <div className="app-main">
                    {titlebar ? <div className="window-titlebar">PiKVM Desktop</div> : null}
                    <main className="app-panel">
                        <Pane id="kvm" active={active === "kvm"}>
                            <KvmPane active={active === "kvm"} />
                        </Pane>
                        <Pane id="chat" active={active === "chat"}>
                            {visited.has("chat") ? <ChatPane active={active === "chat"} /> : null}
                        </Pane>
                        <Pane id="settings" active={onSettings}>
                            {visited.has("settings") ? <SettingsPane page={settingsPage} active={onSettings} /> : null}
                        </Pane>
                    </main>
                </div>
                {bridge && !bridge.nativeControls ? <WindowControls bridge={bridge} /> : null}
                {compact && !hideBar ? <NavTabs active={active} orientation="horizontal" settingsPage={settingsPage} /> : null}
            </div>
        </AgentActivityProvider>
    );
}
