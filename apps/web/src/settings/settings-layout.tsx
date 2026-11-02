/**
 * Settings as a grouped list with detail pages.
 *
 * Phone: the list is the page; opening a row pushes its page with a back button, as iOS and
 * Android settings do. Wide: list and page sit side by side and the first page is open.
 */

import { Link, Navigate, Outlet, useMatch } from "@tanstack/react-router";
import { useProxySession } from "../api/queries";
import { useMediaQuery, COMPACT_QUERY } from "../app/viewport";
import { ChevronLeftIcon, ChevronRightIcon } from "../ui/icons";
import { ACCOUNT_PAGE, findPage, SETTINGS_GROUPS, type SettingsGroupDef } from "./pages";

/** The groups as they should read here: unavailable pages out, Account in when it applies. */
function visibleGroups(hasAccount: boolean): ReadonlyArray<SettingsGroupDef> {
    return SETTINGS_GROUPS.map((group) => {
        const pages = group.pages.filter((page) => page.available?.() ?? true);
        if (group.title !== "App" || !hasAccount) return { ...group, pages };
        const about = pages.findIndex((page) => page.id === "about");
        const at = about < 0 ? pages.length : about;
        return { ...group, pages: [...pages.slice(0, at), ACCOUNT_PAGE, ...pages.slice(at)] };
    });
}

function SettingsList({ selected }: { selected: string | undefined }) {
    const session = useProxySession();
    const groups = visibleGroups(session.data === true);

    return (
        <nav aria-label="Settings" className="px-4 pb-6 pt-2">
            {groups.map((group) => (
                <section key={group.title} className="mb-6">
                    <h2 className="group-label">{group.title}</h2>
                    <div className="group-card">
                        {group.pages.map((page) => (
                            <Link
                                key={page.id}
                                to="/settings/$page"
                                params={{ page: page.id }}
                                className="row"
                                data-selected={page.id === selected}
                            >
                                <span className="row-icon">{page.icon}</span>
                                <span className="row-text row-label">{page.title}</span>
                                <span className="row-hint" aria-hidden="true">
                                    <ChevronRightIcon width={16} height={16} />
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>
            ))}
        </nav>
    );
}

export function SettingsLayout() {
    const compact = useMediaQuery(COMPACT_QUERY);
    const match = useMatch({ from: "/settings/$page", shouldThrow: false });
    const selected = match?.params.page;

    const showList = !compact || selected === undefined;
    const showDetail = !compact || selected !== undefined;

    return (
        <div className="flex h-full min-h-0" data-testid="settings">
            {showList ? (
                <div className={compact ? "h-full w-full overflow-y-auto" : "h-full w-80 shrink-0 overflow-y-auto border-r border-border"}>
                    <h1 className="page-title px-4 pb-2 pt-4">Settings</h1>
                    <SettingsList selected={selected} />
                </div>
            ) : null}
            {showDetail ? (
                <div className="h-full min-w-0 flex-1 overflow-y-auto">
                    <Outlet />
                </div>
            ) : null}
        </div>
    );
}

/** `/settings` itself: on a wide screen open the first page, on a phone show only the list. */
export function SettingsIndex() {
    const compact = useMediaQuery(COMPACT_QUERY);
    if (compact) return null;
    return <Navigate to="/settings/$page" params={{ page: "connection" }} replace />;
}

/** One page of settings under its title, with the way back on a phone. */
export function SettingsDetail({ page }: { page: string }) {
    const compact = useMediaQuery(COMPACT_QUERY);
    const def = findPage(page);

    if (!def) {
        return (
            <div className="empty-state">
                <h1>No such setting</h1>
                <Link to="/settings" className="btn">
                    Back to settings
                </Link>
            </div>
        );
    }

    const Page = def.component;
    return (
        <div className="max-w-2xl px-4 pb-8">
            <header className="flex items-center gap-1 py-3">
                {compact ? (
                    <Link to="/settings" className="tb-btn -ml-2" aria-label="Back to settings">
                        <ChevronLeftIcon />
                    </Link>
                ) : null}
                <h1 className="page-title">{def.title}</h1>
            </header>
            <Page />
        </div>
    );
}
