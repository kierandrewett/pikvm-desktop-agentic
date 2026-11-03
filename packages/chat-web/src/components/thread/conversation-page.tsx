/**
 * Conversation view (reference web layout, notes A.7): the scrolling thread, with the header over its top
 * and the composer docked over its bottom (the thread scrolls under both; ui.blur makes them translucent).
 *
 * Data: stored items (itemsQuery, cached forever and prefetched by the route loader) plus the live
 * response (useLive). turns.ts `splitLive` decides which part of each to show so nothing renders
 * twice. Stored turns are built once per history change and memoised; only the live turn re-renders
 * while a response streams.
 *
 * Load speed: cached conversations render in the first frame and jump to the bottom before paint;
 * long threads render the newest turns first and the rest in a transition, and older turns use
 * `content-visibility: auto`.
 */
import type { ComposerFeatureOptions } from "@pikvm/chat-protocol";
import { ArrowDownIcon, ChatsCircleIcon, CircleNotchIcon } from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../../nav";
import {
    memo,
    startTransition,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import { useT } from "../../l10n/provider";
import { ApiError } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { cn } from "../../lib/cn";
import { useLive } from "../../lib/live";
import { useIsMobile } from "../../lib/media";
import { motionMs } from "../../lib/motion";
import { captureSessionEpoch, isSessionEpochCurrent, itemsQuery, useBootstrap, useSetting } from "../../lib/queries";
import { socket } from "../../lib/socket";
import { subscribeRendererReset } from "../render/resource";
import { Composer } from "../composer/composer";
import { EmptyState, ErrorState, type RetryableQuery } from "../ui/state";
import { ApprovalTray } from "./approval-tray";
import { ElicitationTray } from "./elicitation-tray";
import { QuestionTray } from "./question-tray";
import { sourcesOf, SourcesProvider } from "./sources";
import "./thread.css";
import { addLocalNotice, localOutput, useLocalNotices, type LocalNotice } from "./local-notices";
import { CompactionMarker, LocalNoticeRow, ThreadContext, TurnView, type ThreadContextValue } from "./turn";
import { buildEntries, sameDay, splitLive, type ThreadEntry } from "./turns";
import { useStickToBottom } from "./use-stick-to-bottom";
import { ForkNotice } from "./fork-notice";
import { jumpToUserMessage, userTurnKeys } from "./jump";

/** Turns rendered in the first frame of a long thread; the rest follow in a transition. */
const FIRST_PAINT_ENTRIES = 12;
/** The newest entries skip `content-visibility` so streaming and the bottom stay exact. */
const LIVE_WINDOW = 4;

/**
 * The conversation surface of the Chat pane: the thread with its loading, error and offline states, the trays and the
 * composer. `empty` replaces "No messages yet" before the first message. The pane owns the header and the list.
 */
export interface EmbeddedConversation {
    /** Accessible name of the thread region. */
    label: string;
    empty: ReactNode;
    /** Composer controls and local actions available to this embedded host. */
    features?: ComposerFeatureOptions;
    /** False while the pane is hidden behind another tab: page-wide key listeners stand down. */
    active?: boolean;
}

export function ConversationPane({ conversationId, ...embedded }: { conversationId: string } & EmbeddedConversation) {
    const { data: boot } = useBootstrap();
    if (!boot?.user) return null;
    return <ConversationOwner key={boot.user.id} conversationId={conversationId} embedded={embedded} />;
}

function ConversationOwner({ conversationId, embedded }: { conversationId: string; embedded: EmbeddedConversation }) {
    const [ownerEpoch] = useState(captureSessionEpoch);
    const current = useSyncExternalStore(subscribeRendererReset, () => isSessionEpochCurrent(ownerEpoch));
    const [committed, setCommitted] = useState(false);
    useEffect(() => {
        if (isSessionEpochCurrent(ownerEpoch)) setCommitted(true);
    }, [ownerEpoch]);
    if (!current || !committed) return null;
    return <ConversationView key={conversationId} conversationId={conversationId} embedded={embedded} />;
}

function useSocketOffline(): boolean {
    const status = useSyncExternalStore(
        (fn) => socket.onStatus(fn),
        () => socket.status,
    );
    // Only show the indicator after a second offline, so the first connect never flashes it.
    const [late, setLate] = useState(false);
    useEffect(() => {
        if (status === "open") {
            setLate(false);
            return;
        }
        const t = setTimeout(() => setLate(true), 1000);
        return () => clearTimeout(t);
    }, [status]);
    return status !== "open" && late;
}

function ConversationView({
    conversationId,
    embedded,
}: {
    conversationId: string;
    embedded: EmbeddedConversation;
}) {
    const t = useT();
    const items = useQuery({
        ...itemsQuery(conversationId),
        retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    });
    const live = useLive(conversationId);
    const offline = useSocketOffline();
    const stick = useStickToBottom();
    const pageRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLElement>(null);

    useEffect(() => socket.watch(conversationId), [conversationId]);

    // Local command results are not stored in history: remember each one after the entry that was last.
    const notices = useLocalNotices(conversationId);
    const lastEntryKey = useRef("");
    useEffect(
        () =>
            socket.on((e) => {
                if (!/^response\.(completed|failed|cancelled|incomplete)$/.test(e.type) || !("response" in e)) return;
                const r = e.response;
                if (!r.local || r.conversation.id !== conversationId) return;
                addLocalNotice(conversationId, {
                    id: r.id,
                    output: localOutput(r),
                    failed: r.status !== "completed",
                    anchor: lastEntryKey.current,
                });
            }),
        [conversationId],
    );

    // Sending a message always brings the thread back to the bottom, even if the user had scrolled up.
    const pendingId = live?.pendingInput?.id;
    const { scrollToBottom } = stick;
    useEffect(() => {
        if (pendingId) scrollToBottom();
    }, [pendingId, scrollToBottom]);

    // The composer overlays the scroller (so the thread scrolls under it, see ui.blur). The end spacer tracks its
    // height without re-rendering.
    useLayoutEffect(() => {
        const page = pageRef.current;
        const footer = footerRef.current;
        const scroller = stick.scrollRef.current;
        if (!page || !footer) return;
        const set = () => {
            page.style.setProperty("--thread-footer-h", `${footer.offsetHeight}px`);
            // A classic scrollbar takes width at the scroller's edge; the composer fade stops short of it.
            if (scroller)
                page.style.setProperty("--thread-scrollbar-w", `${scroller.offsetWidth - scroller.clientWidth}px`);
        };
        set();
        const ro = new ResizeObserver(set);
        ro.observe(footer);
        if (scroller) ro.observe(scroller);
        return () => ro.disconnect();
    }, []);

    const history = items.data;
    const { cut, liveTurn } = splitLive(history, live);
    // Keyed on (history, cut), not on a sliced array, so stored turns keep their identity per frame.
    const storedEntries = useMemo(() => buildEntries((history ?? []).slice(0, cut)), [history, cut]);
    lastEntryKey.current = entryKey(storedEntries.at(-1));
    // Once a local result is remembered, the remembered row replaces its live turn.
    const showLive = liveTurn && !(liveTurn.local && notices.some((n) => `live_${n.id}` === liveTurn.key));

    const [limit, setLimit] = useState(FIRST_PAINT_ENTRIES);
    const total = storedEntries.length + (liveTurn ? 1 : 0);
    useEffect(() => {
        if (total <= limit) return;
        const f = requestAnimationFrame(() => startTransition(() => setLimit(Number.POSITIVE_INFINITY)));
        return () => cancelAnimationFrame(f);
    }, [total, limit]);

    const mobile = useIsMobile();
    // Mod+Alt+ArrowUp / ArrowDown: previous or next of your messages (jump.ts). Keys are read when pressed.
    const userKeys = useRef<string[]>([]);
    userKeys.current = useMemo(
        () => userTurnKeys(storedEntries.map((e) => (e.kind === "turn" ? e.turn : undefined))),
        [storedEntries],
    );
    const liveUserKey = liveTurn?.user ? liveTurn.key : undefined;
    const active = embedded.active ?? true;
    // A hidden pane takes no key presses: the listener exists only while the pane is shown.
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const scroller = stick.scrollRef.current;
            if (!scroller || document.querySelector('[role="dialog"][data-state="open"], [role="menu"]')) return;
            const keys = liveUserKey ? [...userKeys.current, liveUserKey] : userKeys.current;
            if (jumpToUserMessage(scroller, keys, e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, stick.scrollRef, liveUserKey]);
    const avatars = useSetting<boolean>("ui.thread.avatars", false);
    const assistantBubbles = useSetting<boolean>("ui.thread.assistantBubbles", false);
    const ctx = useMemo<ThreadContextValue>(
        () => ({ conversationId, avatars, assistantBubbles }),
        [conversationId, avatars, assistantBubbles],
    );
    const liveOutput = live?.response.output;
    const allItems = useMemo(() => [...(history ?? []), ...(liveOutput ?? [])], [history, liveOutput]);
    // Source metadata can arrive on an existing streamed output item, without changing the item count.
    const sources = useMemo(() => sourcesOf(allItems), [allItems]);

    const notFound = items.error instanceof ApiError && items.error.status === 404 && !live;
    const loading = items.isPending && !live;
    const failed = items.isError && !notFound && !live;
    const empty = !loading && !failed && !notFound && total === 0 && notices.length === 0;
    const skeletonTurns = 1;
    const revealing = useReveal(loading);
    const running = !!live && !live.done;

    return (
        <ThreadContext.Provider value={ctx}>
            <SourcesProvider sources={sources}>
                <div ref={pageRef} className="thread-page relative flex h-full min-h-0 bg-surface">
                    <div className="relative flex min-w-0 flex-1 flex-col">
                        <div className="relative min-h-0 flex-1">
                            <div
                                ref={stick.scrollRef}
                                role="region"
                                aria-label={embedded?.label ?? t("thread-page-conversation")}
                                className="thread-scroll flex h-full flex-col"
                                // Focus and scrollIntoView keep targets clear of the bars that overlay the scroller.
                                style={{
                                    scrollPaddingTop: "var(--thread-header-h, 0px)",
                                    scrollPaddingBottom: "var(--thread-footer-h, 0px)",
                                }}
                            >
                                <div
                                    ref={stick.contentRef}
                                    className="thread-content flex min-h-full shrink-0 flex-col"
                                >
                                    <div
                                        aria-hidden
                                        className="shrink-0"
                                        style={{ height: "var(--thread-header-h, 0px)" }}
                                    />
                                    <div className="thread-col relative flex flex-1 shrink-0 flex-col pb-8">
                                        <div className="relative flex min-h-full flex-1 flex-col gap-1.5 pb-5">
                                            {/* Bottom-anchored where the last turn renders; fades out over it on load. */}
                                            {(loading || revealing) && (
                                                <ThreadSkeleton turns={skeletonTurns} leaving={revealing} />
                                            )}
                                            {notFound && <NotFound />}
                                            {failed && <LoadError query={items} />}
                                            {empty &&
                                                (embedded ? (
                                                    <div className="my-auto py-8">{embedded.empty}</div>
                                                ) : (
                                                    <EmptyThread />
                                                ))}
                                            {(total > 0 || notices.length > 0) && (
                                                // mt-auto: while the turns are shorter than the viewport they sit just
                                                // above the composer and grow upward; once they overflow the margin is 0
                                                // and stick-to-bottom scrolling takes over with no jump.
                                                <div
                                                    className={cn(
                                                        "relative mt-auto shrink-0",
                                                        revealing && "thread-reveal",
                                                    )}
                                                >
                                                    <div className="flex flex-col">
                                                        <ForkNotice conversationId={conversationId} />
                                                        <Entries
                                                            entries={storedEntries}
                                                            limit={limit}
                                                            liveCount={liveTurn ? 1 : 0}
                                                            notices={notices}
                                                            liveHasUser={!!(showLive && liveTurn?.user)}
                                                        />
                                                        {showLive && (
                                                            <div className={cn(storedEntries.length > 0 && "mt-3")}>
                                                                <TurnView
                                                                    turn={liveTurn}
                                                                    stamp={stampFor(
                                                                        liveTurn.user?.created_at,
                                                                        lastStamp(storedEntries),
                                                                        storedEntries.length === 0,
                                                                    )}
                                                                    latest
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="z-20 mt-auto" />
                                    <div
                                        aria-hidden
                                        className="shrink-0"
                                        style={{ height: "calc(var(--thread-footer-h, 76px) + var(--scrim-clear))" }}
                                    />
                                </div>
                            </div>

                            {offline && (
                                <div
                                    role="status"
                                    className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
                                    style={{ top: "calc(var(--thread-header-h, 0px) + 8px)" }}
                                >
                                    <div className="flex h-8 items-center gap-2 rounded-full bg-elevated px-3 text-[13px] text-secondary shadow-menu">
                                        <CircleNotchIcon size={14} className="animate-spin" />
                                        {t("thread-page-reconnecting")}
                                    </div>
                                </div>
                            )}

                            <footer
                                ref={footerRef}
                                className="thread-content pointer-events-none absolute inset-x-0 bottom-0 z-20 px-[calc(var(--thread-scrollbar-w,0px)/2)] pb-[max(12px,var(--dock-safe-bottom))]"
                            >
                                {/* Solid, or with ui.blur a progressive blur the thread fades into (app.css). */}
                                <div aria-hidden className="composer-scrim z-0">
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                </div>
                                <div className="thread-col relative z-10 flex flex-col *:pointer-events-auto">
                                    <div className="relative h-0">
                                        <button
                                            type="button"
                                            aria-label={
                                                running ? t("thread-page-jump-latest") : t("thread-page-scroll-bottom")
                                            }
                                            aria-hidden={stick.atBottom}
                                            tabIndex={stick.atBottom ? -1 : 0}
                                            onClick={() => stick.scrollToBottom()}
                                            data-streaming={running || undefined}
                                            className={cn(
                                                "group/stb absolute bottom-6 left-1/2 z-30 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-default bg-surface bg-clip-padding text-secondary transition-opacity duration-150 ease-[cubic-bezier(.4,0,.2,1)] hover:text-text pointer-coarse:size-10",
                                                stick.atBottom ? "pointer-events-none opacity-0" : "opacity-100",
                                            )}
                                        >
                                            <ArrowDownIcon size={20} />
                                            {/* A response is still arriving below: a quiet accent dot says there is more. */}
                                            {running && (
                                                <span
                                                    aria-hidden
                                                    className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface bg-primary-solid"
                                                />
                                            )}
                                        </button>
                                    </div>
                                    <h4 className="sr-only">{t("thread-page-latest")}</h4>
                                    <span role="status" className="sr-only">
                                        {live
                                            ? running
                                                ? t("thread-page-responding")
                                                : t("thread-page-complete")
                                            : ""}
                                    </span>
                                    <ApprovalTray conversationId={conversationId} />
                                    <ElicitationTray conversationId={conversationId} />
                                    <QuestionTray conversationId={conversationId} />
                                    <div className="relative z-10">
                                        <Composer
                                            variant="thread"
                                            conversationId={conversationId}
                                            embedded={!!embedded}
                                            features={embedded?.features}
                                        />
                                    </div>
                                </div>
                            </footer>
                        </div>
                    </div>
                </div>
            </SourcesProvider>
        </ThreadContext.Provider>
    );
}

function turnTime(e: ThreadEntry | undefined): number | undefined {
    return e?.kind === "turn" ? e.turn.user?.created_at : undefined;
}

function lastStamp(entries: ThreadEntry[]): number | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const t = turnTime(entries[i]);
        if (t) return t;
    }
    return undefined;
}

/** Separator above the first turn and wherever the calendar day changes. */
function stampFor(at: number | undefined, prev: number | undefined, first: boolean): number | undefined {
    if (!at) return undefined;
    if (first || !prev || !sameDay(at, prev)) return at;
    return undefined;
}

function entryKey(e: ThreadEntry | undefined): string {
    if (!e) return "";
    return e.kind === "turn" ? e.turn.key : e.item.id;
}

/** A turn that is only a user message (so the next user message continues the same run). */
function userOnly(prev: ThreadEntry | undefined): boolean {
    return prev?.kind === "turn" && !!prev.turn.user && prev.turn.items.length === 0;
}

/** A user message comes straight after (so the bubble before it is not the last in its run). */
function followedByUser(next: ThreadEntry | undefined, liveHasUser: boolean): boolean {
    if (!next) return liveHasUser;
    return next.kind === "turn" && !!next.turn.user;
}

function NoticeRows({ notices, anchor, first }: { notices: LocalNotice[]; anchor: string; first: boolean }) {
    return notices
        .filter((n) => n.anchor === anchor)
        .map((n, i) => (
            <div key={n.id} className={cn((!first || i > 0) && "mt-3")}>
                <LocalNoticeRow output={n.output} running={false} failed={n.failed} />
            </div>
        ));
}

const Entries = memo(function Entries({
    entries,
    limit,
    liveCount,
    notices,
    liveHasUser,
}: {
    entries: ThreadEntry[];
    limit: number;
    liveCount: number;
    notices: LocalNotice[];
    /** The live turn after these starts with a user message (for bubble tails). */
    liveHasUser: boolean;
}) {
    const start = Math.max(0, entries.length + liveCount - limit);
    const out = [];
    if (start === 0) out.push(<NoticeRows key="notices:" notices={notices} anchor="" first />);
    let prev = lastStamp(entries.slice(0, start));
    for (let i = start; i < entries.length; i++) {
        const e = entries[i]!;
        const gap = i > start || (i === 0 && notices.some((n) => n.anchor === "")) ? "mt-3" : undefined;
        const after = (
            <NoticeRows key={`notices:${entryKey(e)}`} notices={notices} anchor={entryKey(e)} first={false} />
        );
        if (e.kind === "compaction") {
            out.push(
                <div key={e.item.id} className={gap}>
                    <CompactionMarker />
                </div>,
                after,
            );
            continue;
        }
        const at = e.turn.user?.created_at;
        const stamp = stampFor(at, prev, i === 0);
        if (at) prev = at;
        out.push(
            <div key={e.turn.key} className={gap}>
                <TurnView
                    turn={e.turn}
                    stamp={stamp}
                    deferred={i < entries.length + liveCount - LIVE_WINDOW}
                    tail={!(e.turn.items.length === 0 && followedByUser(entries[i + 1], liveHasUser))}
                    userAvatar={!userOnly(entries[i - 1])}
                    latest={liveCount === 0 && i === entries.length - 1}
                />
            </div>,
            after,
        );
    }
    return out;
});

/** Fade length for the skeleton to content hand-over, before --motion-scale. */
const REVEAL_MS = 200;

/** True for one fade after the history finishes loading, so the skeleton and the turns can cross-fade. */
function useReveal(loading: boolean): boolean {
    const [revealing, setRevealing] = useState(false);
    const was = useRef(loading);
    // Layout effect: the class lands in the same frame the turns first paint.
    useLayoutEffect(() => {
        const ended = was.current && !loading;
        was.current = loading;
        if (!ended) return;
        setRevealing(true);
        const t = setTimeout(() => setRevealing(false), motionMs(REVEAL_MS));
        return () => clearTimeout(t);
    }, [loading]);
    return revealing;
}

/** One sketched turn: a user bubble on the end side, then three lines of answer. */
function SkeletonTurn({ bubble, lines }: { bubble: string; lines: readonly string[] }) {
    return (
        <div className="flex flex-col gap-6">
            <div
                className={cn(
                    "thread-skeleton ms-auto h-[46px] rounded-[calc(22px*var(--roundness))] bg-sent-bubble",
                    bubble,
                )}
            />
            <div className="flex flex-col gap-3">
                {lines.map((w, i) => (
                    <div key={i} className={cn("thread-skeleton h-4 rounded-full bg-hover", w)} />
                ))}
            </div>
        </div>
    );
}

/**
 * Loading state, anchored to the bottom like the turns (mt-auto). `leaving`: the turns are in; it sits
 * at the same bottom edge, out of the flow, and fades out while they fade in.
 */
function ThreadSkeleton({ turns, leaving }: { turns: number; leaving: boolean }) {
    const t = useT();
    return (
        <div
            aria-busy={!leaving}
            aria-hidden={leaving || undefined}
            aria-label={leaving ? undefined : t("thread-page-loading")}
            className={cn(
                "flex flex-col gap-10",
                leaving ? "thread-skeleton-out pointer-events-none absolute inset-x-0 bottom-5" : "mt-auto shrink-0",
            )}
        >
            {turns > 1 && <SkeletonTurn bubble="w-1/3" lines={["w-full", "w-3/4"]} />}
            <SkeletonTurn bubble="w-2/5" lines={["w-11/12", "w-4/5", "w-3/5"]} />
        </div>
    );
}

function NotFound() {
    const t = useT();
    const home = { label: t("thread-page-new-chat"), link: <Link to="/" /> };
    return (
        <>
            <EmptyState
                size="page"
                icon={ChatsCircleIcon}
                title={t("thread-page-not-found")}
                description={t("thread-page-not-found-hint")}
                action={home}
            />
        </>
    );
}

/** The API tells forbidden apart from a failed load; offline and server errors get their reason from describeError. */
function LoadError({ query }: { query: RetryableQuery }) {
    const t = useT();
    const home = { label: t("thread-page-new-chat"), link: <Link to="/" /> };
    const forbidden = describeError(query.error).kind === "forbidden";
    return (
        <ErrorState
            size="page"
            title={forbidden ? t("thread-page-forbidden") : t("thread-page-load-failed")}
            query={forbidden ? undefined : query}
            error={query.error}
            action={forbidden ? home : undefined}
            secondaryAction={forbidden ? undefined : home}
        />
    );
}

function EmptyThread() {
    const t = useT();
    return (
        <EmptyState
            size="page"
            icon={ChatsCircleIcon}
            title={t("thread-page-empty")}
            description={t("thread-page-empty-hint")}
        />
    );
}
