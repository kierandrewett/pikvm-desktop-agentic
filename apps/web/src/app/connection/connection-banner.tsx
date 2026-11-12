/**
 * The connection banner: a slim line at the top of the app, over every tab, that says in plain words which part of the
 * connection is failing, for how long, and when it is back. It never blocks input. The words come from what was seen:
 * "the host did not answer" is a failed probe, "the host cannot reach the PiKVM" is only the target link while the host
 * answers, and nothing here talks about Wi-Fi or the internet.
 *
 * The slot is a polite live region that is always in the page (hidden while there is nothing to say), so a screen reader
 * hears the text when it appears. Only the clock inside re-renders each second.
 */

import { useEffect, useState } from "react";
import { useAppKvmSession } from "../../kvm/session";
import "./connection.css";
import { formatRoundTrip, formatTicker, recoveredText } from "./format";
import type { ConnectionView } from "./machine";
import { useConnectionMonitor, useConnectionSnapshot } from "./use-connection";

export interface BannerText {
    readonly tone: "warn" | "bad" | "ok";
    readonly lead: string;
    /** Whether a ticking time follows the lead. */
    readonly clock: boolean;
    readonly tail: string;
}

/** The words for a view; null while online. */
export function bannerText(view: ConnectionView): BannerText | null {
    if (view.state === "online" || view.cause === null) return null;
    const resolved = view.endedAt !== null && view.since !== null;
    if (resolved && view.cause !== "slow") {
        return { tone: "ok", lead: recoveredText(view.cause, (view.endedAt ?? 0) - (view.since ?? 0)), clock: false, tail: "" };
    }
    switch (view.cause) {
        case "slow":
            return {
                tone: "warn",
                lead: `The host is slow to answer${view.roundTripMs === null ? "" : ` (${formatRoundTrip(view.roundTripMs)})`}`,
                clock: false,
                tail: "",
            };
        case "pikvm":
            return { tone: "bad", lead: "The host cannot reach the PiKVM.", clock: false, tail: "" };
        case "host":
            return { tone: "bad", lead: "No answer from the host for ", clock: true, tail: ". Reconnecting..." };
        case "device":
            return { tone: "bad", lead: "This device reports no network for ", clock: true, tail: ". Reconnecting..." };
        case "chat":
            return { tone: "bad", lead: "The chat connection has been down for ", clock: true, tail: ". Reconnecting..." };
        case "picture":
            return { tone: "bad", lead: "The picture has been unavailable for ", clock: true, tail: ". Reconnecting..." };
    }
}

/** The one thing that changes every second. */
function Elapsed({ since }: { readonly since: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    return <span className="connection-banner-clock">{formatTicker(now - since)}</span>;
}

export function ConnectionBanner() {
    useConnectionMonitor(useAppKvmSession());
    const { view } = useConnectionSnapshot();
    const text = bannerText(view);
    return (
        <div className="connection-slot" role="status" aria-live="polite" data-testid="connection-slot" hidden={text === null}>
            {text && view.cause !== null ? (
                <div className="connection-banner" data-tone={text.tone} data-cause={view.cause} data-state={view.state}>
                    <span className="connection-banner-dot" aria-hidden="true" />
                    <span>
                        {text.lead}
                        {text.clock && view.since !== null ? <Elapsed since={view.since} /> : null}
                        {text.tail}
                    </span>
                </div>
            ) : null}
        </div>
    );
}
