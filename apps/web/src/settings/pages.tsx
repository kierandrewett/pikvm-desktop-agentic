/** The Settings pages: one component each, listed once with their group and icon. */

import type { ComponentType, ReactNode } from "react";
import {
    BoltIcon,
    EyeIcon,
    InfoIcon,
    KeyboardIcon,
    LinkIcon,
    PointerIcon,
    SpeakerIcon,
    SunMoonIcon,
    UserIcon,
} from "../ui/icons";
import { AboutPage } from "./pages/about";
import { AccountPage } from "./pages/account";
import { AudioPage } from "./pages/audio";
import { ConnectionPage } from "./pages/connection";
import { DisplayPage } from "./pages/display";
import { InputPage } from "./pages/input";
import { KeepAwakePage } from "./pages/keep-awake";
import { KeyboardPage } from "./pages/keyboard";
import { MacrosPage } from "./pages/macros";
import { audioDevicesSupported } from "./pages/audio-devices";
import { KeyIcon } from "./providers/icon";
import { ProvidersPage } from "./providers/providers-page";

export type PageId =
    | "connection"
    | "keep-awake"
    | "keyboard"
    | "input"
    | "macros"
    | "providers"
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
}

export interface SettingsGroupDef {
    readonly title: string;
    readonly pages: ReadonlyArray<SettingsPageDef>;
}

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupDef> = [
    {
        title: "Target",
        pages: [
            { id: "connection", title: "Connection", icon: <LinkIcon />, component: ConnectionPage },
            { id: "keep-awake", title: "Keep awake", icon: <EyeIcon />, component: KeepAwakePage },
        ],
    },
    {
        title: "Input",
        pages: [
            { id: "keyboard", title: "Keyboard", icon: <KeyboardIcon />, component: KeyboardPage },
            { id: "input", title: "Touch and mouse", icon: <PointerIcon />, component: InputPage },
            { id: "macros", title: "Macros", icon: <BoltIcon />, component: MacrosPage },
        ],
    },
    {
        title: "Agent",
        pages: [{ id: "providers", title: "Providers", icon: <KeyIcon />, component: ProvidersPage }],
    },
    {
        title: "App",
        pages: [
            { id: "display", title: "Display", icon: <SunMoonIcon />, component: DisplayPage },
            {
                id: "audio",
                title: "Audio",
                icon: <SpeakerIcon />,
                component: AudioPage,
                available: audioDevicesSupported,
            },
            // The Account page is added by the list itself once the host proves it sits behind
            // the proxy; see SettingsList.
            { id: "about", title: "About", icon: <InfoIcon />, component: AboutPage },
        ],
    },
];

/** Shown only behind oauth2-proxy, so it is not part of the static table. */
export const ACCOUNT_PAGE: SettingsPageDef = {
    id: "account",
    title: "Account",
    icon: <UserIcon />,
    component: AccountPage,
};

export function findPage(id: string): SettingsPageDef | undefined {
    return [...SETTINGS_GROUPS.flatMap((group) => group.pages), ACCOUNT_PAGE].find((page) => page.id === id);
}
