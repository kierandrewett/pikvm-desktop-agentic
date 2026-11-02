/**
 * The route table. Everything the app shows is one of:
 *   /kvm              the KVM screen (the legacy console, until phase 4)
 *   /chat             the agent workspace (the legacy workspace, until phase 3)
 *   /settings[/page]  Settings
 * and `/` goes to the KVM, the thing the app is for.
 */

import { type RouterHistory, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { LegacyWorkspaceFrame } from "../chat/legacy-workspace-frame";
import { LegacyConsoleFrame } from "../kvm/legacy-console-frame";
import { SettingsDetail, SettingsIndex, SettingsLayout } from "../settings/settings-layout";
import { Shell } from "./shell";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({ to: "/kvm", replace: true });
    },
});

const kvmRoute = createRoute({ getParentRoute: () => rootRoute, path: "/kvm", component: LegacyConsoleFrame });

const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat", component: LegacyWorkspaceFrame });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsLayout });

const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/",
    component: SettingsIndex,
});

const settingsPageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "$page",
    component: function SettingsPageRoute() {
        const { page } = settingsPageRoute.useParams();
        return <SettingsDetail page={page} />;
    },
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    kvmRoute,
    chatRoute,
    settingsRoute.addChildren([settingsIndexRoute, settingsPageRoute]),
]);

export interface AppRouterOptions {
    readonly history?: RouterHistory;
    /** The URL prefix the app is served under. */
    readonly basepath?: string;
}

export function createAppRouter(options: AppRouterOptions = {}) {
    return createRouter({
        routeTree,
        basepath: options.basepath ?? import.meta.env.BASE_URL.replace(/\/$/, ""),
        ...(options.history ? { history: options.history } : {}),
        defaultPreload: "intent",
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof createAppRouter>;
    }
}
