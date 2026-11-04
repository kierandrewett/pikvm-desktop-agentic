/**
 * Settings as Chat's Settings is laid out: a navigation column of grouped sections and a page column beside it
 * (wide), or the navigation as a full-screen list that pushes the page, with a back button, as iOS and Android do
 * (phone). The rows, sections and navigation are the settings kit of @pikvm/chat-web; this file is the host's
 * routing around them.
 *
 * On a phone the page slides in from the right and back out again (View Transitions, where the browser has them and
 * the person has not asked for less motion: settings-motion.css), and an edge swipe from the left goes back with the
 * page following the finger (edge-swipe.ts). Wide windows just change the page. The swipe is attached to this stack
 * only: it never listens on the KVM or Chat tabs, whose touches belong to the picture and the composer.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import {
    Button,
    SettingRow,
    SettingsCard,
    SettingsChrome,
    SettingsNavFrame,
    SettingsNavItem,
    SettingsNavList,
    SettingsNavSection,
    SettingsPage,
    SettingsScope,
    SettingsSection,
} from "@pikvm/chat-web/settings";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../api/queries";
import { COMPACT_QUERY, useMediaQuery } from "../app/viewport";
import { useEdgeSwipeBack } from "./edge-swipe";
import { ACCOUNT_PAGE, findPage, SETTINGS_GROUPS, type SettingsGroupDef } from "./pages";
import "./settings-motion.css";

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

type Direction = "forward" | "back";

/** How long the attribute that selects a slide direction stays on <html>: past the longest transition. */
const DIRECTION_MS = 600;

/**
 * One removal timer for the whole app, not per component: the list that starts a forward slide unmounts as the page
 * opens, and a per-instance timer cleared on unmount left data-settings-nav on <html> for good.
 */
let directionTimer: ReturnType<typeof setTimeout> | undefined;

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A phone's page change slides: a view transition, where the browser has them and motion is welcome (wide windows get
 * none). `enabled` is what to hand the router; `mark` names the direction on <html> for settings-motion.css for as long
 * as the transition lasts, and is called when the change is made, not when it is drawn.
 */
function useSlide(compact: boolean) {
    const mark = useCallback(
        (direction: Direction): boolean => {
            const animate = compact && "startViewTransition" in document && !reducedMotion();
            if (animate) {
                const root = document.documentElement;
                root.setAttribute("data-settings-nav", direction);
                clearTimeout(directionTimer);
                directionTimer = setTimeout(() => root.removeAttribute("data-settings-nav"), DIRECTION_MS);
            }
            return animate;
        },
        [compact],
    );
    return { enabled: compact && typeof document !== "undefined" && "startViewTransition" in document, mark };
}

function SettingsList({ selected, compact }: { selected: string | undefined; compact: boolean }) {
    const session = useSession();
    const groups = visibleGroups(session.data?.signIn === true);
    const slide = useSlide(compact);

    return (
        <SettingsNavFrame label="Settings" title="Settings">
            {groups.map((group) => (
                <SettingsNavSection key={group.title} id={`settings-${group.title.toLowerCase()}`} title={group.title}>
                    <SettingsNavList>
                        {group.pages.map((page) => (
                            <SettingsNavItem
                                key={page.id}
                                icon={page.icon}
                                label={page.title}
                                active={page.id === selected}
                                render={(row) => (
                                    <Link
                                        to="/settings/$page"
                                        params={{ page: page.id }}
                                        viewTransition={slide.enabled && !reducedMotion()}
                                        {...row}
                                        onClick={() => slide.mark("forward")}
                                    />
                                )}
                            />
                        ))}
                    </SettingsNavList>
                </SettingsNavSection>
            ))}
        </SettingsNavFrame>
    );
}

/** The page a pathname names: `/settings/keyboard` is "keyboard", `/settings` is none. */
export function settingsPageOf(pathname: string): string | undefined {
    const page = pathname.split("/")[2];
    return page ? page : undefined;
}

interface SettingsPaneProps {
    /** The page to show; undefined is the list. */
    readonly page: string | undefined;
    /** Settings is the tab in front. It stays mounted while another is, so this gates anything that navigates. */
    readonly active: boolean;
}

export function SettingsPane({ page, active }: SettingsPaneProps) {
    const compact = useMediaQuery(COMPACT_QUERY);
    const navigate = useNavigate();

    // Beside the list there is always a page, so a wide screen at `/settings` opens the first one.
    const selected = page ?? (compact ? undefined : "connection");
    useEffect(() => {
        if (active && page === undefined && !compact) {
            void navigate({ to: "/settings/$page", params: { page: "connection" }, replace: true });
        }
    }, [active, page, compact, navigate]);

    return (
        <SettingsScope active={active}>
            {compact ? (
                <PhoneStack selected={selected} active={active} />
            ) : (
                <div className="flex h-full min-h-0 bg-surface text-text" data-testid="settings">
                    <div className="h-full w-[var(--sidebar-width)] shrink-0 border-e border-default bg-sidebar">
                        <SettingsList selected={selected} compact={false} />
                    </div>
                    <Content page={selected} chrome={NO_CHROME} />
                </div>
            )}
        </SettingsScope>
    );
}

const NO_CHROME = {};

/** The phone: the list is the page; opening a row pushes its page over it, and back reveals the list again. */
function PhoneStack({ selected, active }: { selected: string | undefined; active: boolean }) {
    const navigate = useNavigate();
    const slide = useSlide(true);
    const under = useRef<HTMLDivElement>(null);
    const [swiping, setSwiping] = useState(false);

    const back = useCallback(
        (animate: boolean) => {
            void navigate({ to: "/settings", viewTransition: animate && slide.mark("back") });
        },
        [navigate, slide],
    );
    const chrome = useMemo(() => ({ onBack: () => back(true) }), [back]);

    // The page follows the finger; the list underneath is mounted for the swipe and moves a third as far.
    const top = useRef<HTMLDivElement>(null);
    useEdgeSwipeBack({
        target: top,
        under,
        enabled: active && selected !== undefined,
        onStart: () => setSwiping(true),
        onEnd: (committed) => {
            setSwiping(false);
            if (committed) back(false);
        },
    });

    return (
        <div className="settings-stack relative h-full min-h-0 overflow-hidden bg-sidebar text-text" data-testid="settings">
            {selected === undefined || swiping ? (
                <div ref={under} className="absolute inset-0 bg-sidebar">
                    <SettingsList selected={selected} compact />
                </div>
            ) : null}
            {selected !== undefined ? (
                <div ref={top} className="absolute inset-0 bg-surface">
                    <Content page={selected} chrome={chrome} />
                </div>
            ) : null}
        </div>
    );
}

/** The page column: its own scroll container, back at the top for each page. */
function Content({ page, chrome }: { page: string | undefined; chrome: { onBack?: () => void } }) {
    const scroller = useRef<HTMLDivElement>(null);
    useEffect(() => {
        scroller.current?.scrollTo({ top: 0 });
    }, [page]);
    return (
        <SettingsChrome.Provider value={chrome}>
            <div
                ref={scroller}
                data-settings-scroll=""
                // Vertical only: an auto overflow-x makes Chrome treat a horizontal touch as a scroll attempt on this
                // element and cancel the pointer, so the edge swipe never engages on a phone.
                className="h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
            >
                {page === undefined ? null : <SettingsDetail page={page} />}
            </div>
        </SettingsChrome.Provider>
    );
}

/** One page of settings, drawn on the kit under its own title. */
export function SettingsDetail({ page }: { page: string }) {
    const def = findPage(page);

    if (!def) return <Missing page={page} />;

    const Page = def.component;
    return <Page />;
}

function Missing({ page }: { page: string }): ReactNode {
    return (
        <SettingsPage title="Page not found">
            <SettingsSection>
                <SettingsCard>
                    <SettingRow
                        label="This page does not exist"
                        description={`There is no settings page called "${page}".`}
                        control={
                            <Button asChild>
                                <Link to="/settings">Back to settings</Link>
                            </Button>
                        }
                    />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
