/** The Settings pages: one component each, listed once with their group and icon. */

import type { ComponentType, ReactNode } from "react";
import {
    Bell,
    Brain,
    Cursor,
    Eye,
    Info,
    Key,
    Keyboard,
    Lightning,
    Robot,
    Link,
    CircleHalf,
    SpeakerHigh,
    User,
} from "@pikvm/icons";
import { AboutPage } from "./pages/about";
import { AccountPage } from "./pages/account";
import { AudioPage } from "./pages/audio";
import { ConnectionPage } from "./pages/connection";
import { DisplayPage } from "./pages/display";
import { InputPage } from "./pages/input";
import { KeepAwakePage } from "./pages/keep-awake";
import { KeyboardPage } from "./pages/keyboard";
import { NotificationsPage } from "./pages/notifications";
import { MacrosPage } from "./pages/macros";
import { audioDevicesSupported } from "./pages/audio-devices";
import { AgentPage, ModelsPage, ProvidersPage } from "./chat-pages";

export type PageId =
    | "connection"
    | "keep-awake"
    | "notifications"
    | "keyboard"
    | "input"
    | "macros"
    | "providers"
    | "models"
    | "agent"
    | "display"
    | "audio"
    | "account"
    | "about";

export interface SettingsPageDef {
    readonly id: PageId;
    readonly title: string;
    readonly icon: ReactNode;
    readonly component: ComponentType;
    /** Omit the page when this says it cannot work here. */
    readonly available?: () => boolean;
    /** A page with a list beside an editor, which wants more than a column of rows. */
    readonly wide?: boolean;
}

export interface SettingsGroupDef {
    readonly title: string;
    readonly pages: ReadonlyArray<SettingsPageDef>;
}

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupDef> = [
    {
        title: "Target",
        pages: [
            { id: "connection", title: "Connection", icon: <Link />, component: ConnectionPage },
            { id: "keep-awake", title: "Keep awake", icon: <Eye />, component: KeepAwakePage },
            { id: "notifications", title: "Notifications", icon: <Bell />, component: NotificationsPage },
        ],
    },
    {
        title: "Input",
        pages: [
            { id: "keyboard", title: "Keyboard", icon: <Keyboard />, component: KeyboardPage },
            { id: "input", title: "Touch and mouse", icon: <Cursor />, component: InputPage },
            { id: "macros", title: "Macros", icon: <Lightning />, component: MacrosPage, wide: true },
        ],
    },
    {
        title: "Agent",
        pages: [
            { id: "providers", title: "Providers", icon: <Key />, component: ProvidersPage },
            { id: "models", title: "Models", icon: <Brain />, component: ModelsPage },
            { id: "agent", title: "Agent", icon: <Robot />, component: AgentPage },
        ],
    },
    {
        title: "App",
        pages: [
            { id: "display", title: "Display", icon: <CircleHalf />, component: DisplayPage },
            {
                id: "audio",
                title: "Audio",
                icon: <SpeakerHigh />,
                component: AudioPage,
                available: audioDevicesSupported,
            },
            // The Account page is added by the list itself once the host proves it sits behind
            // the proxy; see SettingsList.
            { id: "about", title: "About", icon: <Info />, component: AboutPage },
        ],
    },
];

/** Shown only behind oauth2-proxy, so it is not part of the static table. */
export const ACCOUNT_PAGE: SettingsPageDef = {
    id: "account",
    title: "Account",
    icon: <User />,
    component: AccountPage,
};

export function findPage(id: string): SettingsPageDef | undefined {
    return [...SETTINGS_GROUPS.flatMap((group) => group.pages), ACCOUNT_PAGE].find((page) => page.id === id);
}
