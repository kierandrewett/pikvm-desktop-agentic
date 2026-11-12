/**
 * The connection monitor's rules, with no timers and no network in them.
 *
 * The page talks to the host over separate channels, and each can fail on its own:
 *
 * - host: a cheap request the monitor sends itself (`probe.ts`). The only channel that says whether the HOST answers.
 * - picture: the video stream (the status chip and overlay on the KVM screen already explain it).
 * - chat: the chat server's WebSocket (its own toast already says "Reconnecting to the server").
 * - pikvm: the engine's target link, a socket to the host that the host keeps open to the PiKVM. Only that link, and
 *   only while the host itself answers, can say "the host cannot reach the PiKVM". A failed probe never can.
 *
 * Only failures seen on those paths are reported. The browser's `offline` event is a report from the device, not a
 * failure of any channel: it is shown as "this device reports no network", and one answer from the host cancels it. Nothing
 * here says the Wi-Fi or the internet is up or down.
 *
 * A driver (`monitor.ts`) feeds events in and calls `tick()` about once a second; the clock is injected.
 */

import type { SignalState } from "@pikvm/kvm-engine";

/** A probe that takes longer than this counts as slow. */
export const SLOW_MS = 1500;
/** A probe that has not answered after this is a failed probe. */
export const PROBE_TIMEOUT_MS = 4000;
/** Time between the starts of two probes while the tab is visible, and while it is hidden. */
export const PROBE_VISIBLE_MS = 5000;
export const PROBE_HIDDEN_MS = 15_000;
/** A banner state stays at least this long before it is replaced by another one. */
export const HOLD_MS = 3000;
/** The "Connection back" line stays this long. */
export const BACK_MS = 4000;
/** A channel other than the host must be down this long before it is reported: each has its own quick retry. */
export const CHANNEL_GRACE_MS = 6000;
/** Outages kept. */
export const MAX_OUTAGES = 10;

export type ConnectionState = "online" | "slow" | "lost" | "host-ok-pikvm-down";

/**
 * What went wrong, as seen: the host did not answer, the device reported no network, the host answered but its link to
 * the PiKVM is closed, the chat socket or the picture stream is down, or the host answers slowly.
 */
export type OutageCause = "host" | "device" | "pikvm" | "chat" | "picture" | "slow";

export interface ConnectionView {
    readonly state: ConnectionState;
    readonly cause: OutageCause | null;
    /** When the outage began on the injected clock; null while online. */
    readonly since: number | null;
    /** When it ended, while the banner still shows it ("Connection back after ..."); null while it goes on. */
    readonly endedAt: number | null;
    /** The newest round trip of the host probe, for the "slow" text. */
    readonly roundTripMs: number | null;
}

export interface Outage {
    readonly startedAt: number;
    /** Null while it goes on. */
    readonly endedAt: number | null;
    readonly longestRoundTripMs: number;
    readonly cause: OutageCause;
}

export interface ConnectionSnapshot {
    /** What the banner shows (held, see HOLD_MS). */
    readonly view: ConnectionView;
    /** Newest first; the one in progress, if any, is first with `endedAt` null. */
    readonly outages: ReadonlyArray<Outage>;
}

export type ChatStatus = "connecting" | "open" | "closed";

export interface LinkState {
    readonly open: boolean;
    readonly connecting: boolean;
    readonly everSettled: boolean;
}

export interface MachineOptions {
    readonly now: () => number;
    /** Outages from an earlier visit (newest first, all ended). */
    readonly outages?: ReadonlyArray<Outage>;
    readonly onOutagesChange?: (ended: ReadonlyArray<Outage>) => void;
    /** An outage has ended. Not called for a slow spell. */
    readonly onRecovered?: (outage: Outage & { readonly endedAt: number }) => void;
}

export interface ConnectionMachine {
    /** Whether a probe should start now: none in flight, and its interval has passed (or something asked for one). */
    probeDue(): boolean;
    probeStarted(): void;
    /** The probe was cut off by the monitor stopping: neither an answer nor a failure. */
    probeAbandoned(): void;
    probeSucceeded(roundTripMs: number): void;
    probeFailed(elapsedMs: number): void;
    /**
     * The probe has no verdict: another channel to the host showed it alive, quickly, while the probe waited. A probe that never left
     * the browser's queue (six connections per host over HTTP/1.1, shared by every stream the page holds open) is this, not a failure,
     * so it counts as neither a failure nor a slow answer, and the host counts as alive.
     */
    probeUnknown(): void;
    /** The browser's `offline` and `online` events. */
    deviceOffline(): void;
    deviceOnline(): void;
    setHidden(hidden: boolean): void;
    setChat(status: ChatStatus | null): void;
    setPicture(signal: SignalState | null): void;
    setLink(link: LinkState | null): void;
    /** Re-read the clock: holds and grace periods end. */
    tick(): void;
    getSnapshot(): ConnectionSnapshot;
    subscribe(listener: () => void): () => void;
}

const SEVERITY: Readonly<Record<OutageCause, number>> = { host: 6, device: 5, pikvm: 4, picture: 3, chat: 2, slow: 1 };

const ONLINE: ConnectionView = { state: "online", cause: null, since: null, endedAt: null, roundTripMs: null };

/** The stream states the KVM screen words as "Reconnecting" or "Screen unavailable". "No signal" is the target's, not the connection's. */
const pictureDown = (signal: SignalState): boolean =>
    signal === "offline" || signal === "reconnecting" || signal === "disconnected";

interface Candidate {
    readonly cause: OutageCause;
    readonly since: number;
}

const stateOf = (cause: OutageCause): ConnectionState =>
    cause === "slow" ? "slow" : cause === "pikvm" ? "host-ok-pikvm-down" : "lost";

const sameView = (a: ConnectionView, b: ConnectionView): boolean =>
    a.state === b.state &&
    a.cause === b.cause &&
    a.since === b.since &&
    a.endedAt === b.endedAt &&
    a.roundTripMs === b.roundTripMs;

export function createConnectionMachine(options: MachineOptions): ConnectionMachine {
    const { now } = options;
    let ended: ReadonlyArray<Outage> = options.outages ?? [];
    let current: Outage | null = null;
    let snapshot: ConnectionSnapshot = { view: ONLINE, outages: ended };
    const listeners = new Set<() => void>();

    // The host probe.
    let hidden = false;
    let inFlight = false;
    let lastStartAt = Number.NEGATIVE_INFINITY;
    let probeNow = true;
    let startedAt = 0;
    let fails = 0;
    let bad = 0;
    let badSince = 0;
    let answered = false;
    let roundTripMs: number | null = null;
    let longestInRun = 0;

    // The other channels.
    let deviceOfflineSince: number | null = null;
    let chat: ChatStatus | null = null;
    let chatEverOpen = false;
    let chatDownSince: number | null = null;
    let picture: SignalState | null = null;
    let pictureEverLive = false;
    let pictureDownSince: number | null = null;
    let link: LinkState | null = null;
    let linkEverOpen = false;
    let linkDownSince: number | null = null;

    // The banner.
    let shown: ConnectionView = ONLINE;
    let shownAt = Number.NEGATIVE_INFINITY;

    const candidate = (at: number): Candidate | null => {
        const hostLost = fails >= 2;
        if (hostLost || deviceOfflineSince !== null) {
            const since = Math.min(hostLost ? badSince : Number.POSITIVE_INFINITY, deviceOfflineSince ?? Number.POSITIVE_INFINITY);
            return { cause: hostLost ? "host" : "device", since };
        }
        const grace = (since: number | null): since is number => since !== null && at - since >= CHANNEL_GRACE_MS;
        // A host that answers slowly explains a picture or a chat socket that struggles over the same path: it is the cause, so it is said first.
        if (bad >= 2) return { cause: "slow", since: badSince };
        // The host answers, and promptly (a slow or failing probe has its own words, and a link that cannot reopen over a slow
        // path says nothing about the PiKVM): a closed link is the host's link to the PiKVM.
        if (answered && bad === 0 && grace(linkDownSince)) return { cause: "pikvm", since: linkDownSince };
        if (grace(pictureDownSince)) return { cause: "picture", since: pictureDownSince };
        if (grace(chatDownSince)) return { cause: "chat", since: chatDownSince };
        return null;
    };

    const emit = (): void => {
        for (const listener of [...listeners]) listener();
    };

    const publish = (): void => {
        const outages = current ? [current, ...ended] : ended;
        const same =
            sameView(snapshot.view, shown) &&
            snapshot.outages.length === outages.length &&
            snapshot.outages.every((outage, index) => outage === outages[index]);
        if (same) return;
        snapshot = { view: shown, outages };
        emit();
    };

    const evaluate = (): void => {
        const at = now();
        const found = candidate(at);

        // The log.
        if (found && !current) {
            current = { startedAt: found.since, endedAt: null, longestRoundTripMs: longestInRun, cause: found.cause };
        } else if (found && current) {
            const cause = SEVERITY[found.cause] > SEVERITY[current.cause] ? found.cause : current.cause;
            const startedAt = Math.min(current.startedAt, found.since);
            if (cause !== current.cause || startedAt !== current.startedAt) current = { ...current, cause, startedAt };
        } else if (!found && current) {
            const done = { ...current, endedAt: at };
            current = null;
            longestInRun = 0;
            ended = [done, ...ended].slice(0, MAX_OUTAGES);
            options.onOutagesChange?.(ended);
            if (done.cause !== "slow") options.onRecovered?.(done);
            // The banner keeps the state it had, marked ended, until its hold and the "back" line are over.
            if (shown.state !== "online" && shown.endedAt === null) shown = { ...shown, endedAt: at };
        }

        // The banner.
        if (found) {
            const target: ConnectionView = {
                state: stateOf(found.cause),
                cause: current?.cause ?? found.cause,
                since: current?.startedAt ?? found.since,
                endedAt: null,
                roundTripMs,
            };
            const sameKind = shown.endedAt === null && shown.state === target.state && shown.cause === target.cause;
            if (sameKind) shown = { ...shown, since: target.since, roundTripMs: target.roundTripMs };
            else if (at - shownAt >= HOLD_MS) {
                shown = target;
                shownAt = at;
            }
        } else if (shown.state !== "online" && shown.endedAt !== null) {
            const slow = shown.cause === "slow";
            if (at - shownAt >= HOLD_MS && (slow || at - shown.endedAt >= BACK_MS)) {
                shown = ONLINE;
                shownAt = at;
            }
        }
        publish();
    };

    const channelDown = (since: number | null, down: boolean): number | null => {
        if (!down || hidden) return null;
        return since ?? now();
    };

    const refreshChannels = (): void => {
        chatDownSince = channelDown(chatDownSince, chatEverOpen && chat !== null && chat !== "open");
        pictureDownSince = channelDown(pictureDownSince, pictureEverLive && picture !== null && pictureDown(picture));
        linkDownSince = channelDown(linkDownSince, linkEverOpen && link !== null && !link.open);
    };

    const settle = (ms: number, ok: boolean): void => {
        inFlight = false;
        longestInRun = Math.max(longestInRun, ms);
        const wasBad = bad > 0;
        const wasFailing = fails > 0;
        if (ok) {
            answered = true;
            roundTripMs = ms;
            fails = 0;
            // The host answered, so the device's report of no network is out of date.
            deviceOfflineSince = null;
            bad = ms > SLOW_MS ? bad + 1 : 0;
            // The host is back: its other channels reconnect now, so they get a fresh grace period instead of being blamed at once.
            if (wasFailing) {
                chatDownSince = null;
                pictureDownSince = null;
                linkDownSince = null;
            }
        } else {
            fails += 1;
            bad += 1;
        }
        if (bad > 0 && !wasBad) badSince = startedAt;
        if (current) current = { ...current, longestRoundTripMs: Math.max(current.longestRoundTripMs, ms) };
        else if (bad === 0) longestInRun = 0;
        refreshChannels();
        evaluate();
    };

    return {
        probeDue() {
            if (inFlight) return false;
            return probeNow || now() - lastStartAt >= (hidden ? PROBE_HIDDEN_MS : PROBE_VISIBLE_MS);
        },
        probeStarted() {
            inFlight = true;
            probeNow = false;
            lastStartAt = now();
            startedAt = lastStartAt;
        },
        probeAbandoned() {
            inFlight = false;
            probeNow = true;
        },
        probeUnknown() {
            inFlight = false;
            const wasFailing = fails > 0;
            fails = 0;
            bad = 0;
            deviceOfflineSince = null;
            if (wasFailing) {
                chatDownSince = null;
                pictureDownSince = null;
                linkDownSince = null;
            }
            if (!current) longestInRun = 0;
            refreshChannels();
            evaluate();
        },
        probeSucceeded(ms) {
            settle(ms, true);
        },
        probeFailed(ms) {
            settle(ms, false);
        },
        deviceOffline() {
            deviceOfflineSince ??= now();
            evaluate();
        },
        deviceOnline() {
            // Ask the host: the event alone proves nothing about it.
            probeNow = true;
        },
        setHidden(value) {
            if (hidden === value) return;
            hidden = value;
            // A page that was away learns nothing from sockets that slept: count their downtime from now, and ask the host at once.
            if (!value) probeNow = true;
            refreshChannels();
            evaluate();
        },
        setChat(status) {
            chat = status;
            if (status === "open") chatEverOpen = true;
            if (status === null) chatEverOpen = false;
            refreshChannels();
            evaluate();
        },
        setPicture(signal) {
            picture = signal;
            if (signal === "live") pictureEverLive = true;
            if (signal === null) pictureEverLive = false;
            refreshChannels();
            evaluate();
        },
        setLink(next) {
            link = next;
            if (next?.open) linkEverOpen = true;
            if (next === null) linkEverOpen = false;
            refreshChannels();
            evaluate();
        },
        tick() {
            evaluate();
        },
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
