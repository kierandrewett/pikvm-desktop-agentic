/** Words and times for the banner, the toast and the list of drops. ASCII only; British English. */

import type { OutageCause } from "./machine";

const pad = (value: number): string => String(value).padStart(2, "0");

/** The banner's ticking time: 0:42, 1:04, 1:02:03. */
export function formatTicker(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A length in words: 42 s, 1 min 04 s, 1 h 02 min. */
export function formatLength(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min ${pad(total % 60)} s`;
    return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** A round trip: 2.9 s, or 640 ms. */
export function formatRoundTrip(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** The toast when an outage ends. It names the channel that came back. */
export function recoveredText(cause: OutageCause, durationMs: number): string {
    const length = formatLength(durationMs);
    switch (cause) {
        case "host":
        case "device":
        case "slow":
            return `Connection back after ${length}`;
        case "pikvm":
            return `The host can reach the PiKVM again after ${length}`;
        case "chat":
            return `The chat connection is back after ${length}`;
        case "picture":
            return `The picture is back after ${length}`;
    }
}

/** The cause as the list of drops words it. */
export function causeText(cause: OutageCause): string {
    switch (cause) {
        case "host":
            return "The host did not answer";
        case "device":
            return "This device reported no network";
        case "pikvm":
            return "The host could not reach the PiKVM";
        case "chat":
            return "The chat connection was down";
        case "picture":
            return "The picture was down";
        case "slow":
            return "The host was slow to answer";
    }
}
