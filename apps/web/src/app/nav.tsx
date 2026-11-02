/**
 * The app's three destinations as an ARIA tablist: a bottom bar on phones, a slim rail on
 * wide screens. One component, two orientations, so the behaviour cannot drift apart.
 *
 * Tabs are links (they are real routes, so long-press and middle-click work and the URL is
 * the state). Keyboard: Left/Right or Up/Down move focus along the list, Home/End jump to the
 * ends, Enter or Space opens the focused tab. Activation is manual on purpose: the KVM and
 * chat tabs each load a whole surface, and arrowing past one must not start loading it.
 */

import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { ChatIcon, MonitorIcon, SettingsIcon } from "../ui/icons";
import { preloadChat } from "./chat-pane";

export type TabId = "kvm" | "chat" | "settings";

interface TabDef {
    readonly id: TabId;
    readonly to: "/kvm" | "/chat" | "/settings";
    readonly label: string;
    readonly icon: ReactNode;
    /** Warm what the tab will need, when the pointer or focus arrives. */
    readonly preload?: () => void;
}

export const TABS: ReadonlyArray<TabDef> = [
    { id: "kvm", to: "/kvm", label: "KVM", icon: <MonitorIcon /> },
    { id: "chat", to: "/chat", label: "Chat", icon: <ChatIcon />, preload: preloadChat },
    { id: "settings", to: "/settings", label: "Settings", icon: <SettingsIcon /> },
];

export const tabDomId = (id: TabId): string => `tab-${id}`;
export const panelDomId = (id: TabId): string => `panel-${id}`;

/** Which destination a pathname (basepath already stripped) belongs to. */
export function activeTab(pathname: string): TabId | undefined {
    return TABS.find((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`))?.id;
}

interface NavTabsProps {
    readonly active: TabId | undefined;
    readonly orientation: "horizontal" | "vertical";
    /** The Settings page that was open when the user last left Settings, if any. */
    readonly settingsPage?: string | undefined;
}

export function NavTabs({ active, orientation, settingsPage }: NavTabsProps) {
    const list = useRef<HTMLDivElement>(null);

    const move = (event: KeyboardEvent<HTMLDivElement>) => {
        const tabs = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
        const here = tabs.findIndex((tab) => tab === document.activeElement);
        if (tabs.length === 0) return;
        let next = -1;
        switch (event.key) {
            case "ArrowRight":
            case "ArrowDown":
                next = here < 0 ? 0 : (here + 1) % tabs.length;
                break;
            case "ArrowLeft":
            case "ArrowUp":
                next = here < 0 ? tabs.length - 1 : (here - 1 + tabs.length) % tabs.length;
                break;
            case "Home":
                next = 0;
                break;
            case "End":
                next = tabs.length - 1;
                break;
            case " ":
                // Links activate on Enter by themselves; a tab also activates on Space.
                if (here >= 0) {
                    event.preventDefault();
                    tabs[here]?.click();
                }
                return;
            default:
                return;
        }
        event.preventDefault();
        tabs[next]?.focus();
    };

    return (
        <div
            ref={list}
            className={orientation === "horizontal" ? "nav-bar" : "nav-rail"}
            role="tablist"
            aria-label="Sections"
            aria-orientation={orientation}
            onKeyDown={move}
        >
            {TABS.map((tab) => {
                const selected = tab.id === active;
                // Settings opens where it was left, not at its list.
                const target =
                    tab.id === "settings" && settingsPage !== undefined
                        ? ({ to: "/settings/$page", params: { page: settingsPage } } as const)
                        : ({ to: tab.to } as const);
                return (
                    <Link
                        key={tab.id}
                        {...target}
                        id={tabDomId(tab.id)}
                        role="tab"
                        className="nav-tab"
                        aria-selected={selected}
                        aria-controls={panelDomId(tab.id)}
                        // Roving tabindex: one stop in the tab order, arrows do the rest.
                        tabIndex={selected || (active === undefined && tab.id === "kvm") ? 0 : -1}
                        draggable={false}
                        onPointerEnter={tab.preload}
                        onFocus={tab.preload}
                    >
                        {tab.icon}
                        <span>{tab.label}</span>
                    </Link>
                );
            })}
        </div>
    );
}
