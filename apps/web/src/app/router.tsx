/**
 * The route table. The URL is the source of truth for which destination is in front:
 *   /kvm              the KVM screen
 *   /chat             the conversation pane (@pikvm/chat-web)
 *   /settings[/page]  Settings
 * and `/` goes to the KVM, the thing the app is for.
 *
 * The routes carry no components of their own. The three destinations are panes the shell keeps
 * mounted (panes.tsx) and shows or hides by what the URL says, so a tab change never unloads the
 * picture, the conversation or the open settings page, and back and forward still move between them.
 */

import { type RouterHistory, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Shell } from "./shell";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({ to: "/kvm", replace: true });
    },
});

const kvmRoute = createRoute({ getParentRoute: () => rootRoute, path: "/kvm" });

const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat" });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings" });

const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: "/" });

const settingsPageRoute = createRoute({ getParentRoute: () => settingsRoute, path: "$page" });

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
