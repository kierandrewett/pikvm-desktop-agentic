/** Small pieces the list, the search results and the watch page share. */

import type { RecordingView } from "@pikvm/contracts/recordings";
import { Clock, FilmStrip, Warning } from "@pikvm/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { expiryOf, formatDuration, statusOf } from "./format";
import { loadPoster } from "./poster";

/** `text` with the `ranges` ([start, end) in UTF-16 units, in order) in <mark>s. Always text: nothing in it is ever markup. */
export function Highlighted({ text, ranges }: { readonly text: string; readonly ranges: ReadonlyArray<readonly [number, number]> }) {
    const parts: ReactNode[] = [];
    let at = 0;
    ranges.forEach(([start, end], i) => {
        if (start < at || end <= start || end > text.length) return;
        if (start > at) parts.push(text.slice(at, start));
        parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
        at = end;
    });
    if (at < text.length) parts.push(text.slice(at));
    return <>{parts}</>;
}

export function StatusPill({ recording }: { readonly recording: RecordingView }) {
    const status = statusOf(recording);
    return (
        <span className="rl-pill" data-tone={status.tone} title={status.title}>
            {status.tone === "bad" ? <Warning weight="fill" aria-hidden="true" /> : <span className="rl-pill-dot" aria-hidden="true" />}
            <span>{status.label}</span>
            {status.progress !== null ? (
                <span className="rl-pill-bar" role="progressbar" aria-label="Transcription progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)}>
                    <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </span>
            ) : null}
        </span>
    );
}

export function Expiry({ recording }: { readonly recording: RecordingView }) {
    const expiry = expiryOf(recording);
    if (expiry === null) return <span className="rl-muted">-</span>;
    return (
        <span className="rl-expiry" data-soon={expiry.soon || undefined}>
            {expiry.soon ? <Clock aria-hidden="true" /> : null}
            {expiry.text}
        </span>
    );
}

/**
 * The first frame of a recording. It is asked for only once the thumbnail is near the screen, so a long list does not fetch every
 * file at once. A recording with no picture (still being made, empty, a codec this browser lacks) shows a film strip.
 */
export function Poster({ recording, className = "rl-thumb-img" }: { readonly recording: RecordingView; readonly className?: string }) {
    const box = useRef<HTMLSpanElement>(null);
    const [near, setNear] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const playable = recording.status !== "recording" && recording.status !== "failed" && recording.bytes > 0;

    useEffect(() => {
        const el = box.current;
        if (!el || !playable) return;
        if (typeof IntersectionObserver === "undefined") {
            setNear(true);
            return;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setNear(true);
                    watch.disconnect();
                }
            },
            { rootMargin: "200px" },
        );
        watch.observe(el);
        return () => watch.disconnect();
    }, [playable]);

    useEffect(() => {
        if (!near || !playable) return;
        let current = true;
        void loadPoster(recording.id).then((made) => {
            if (current) setUrl(made);
        });
        return () => {
            current = false;
        };
    }, [near, playable, recording.id]);

    return (
        <span ref={box} className={className} data-has-image={url !== null || undefined}>
            {url !== null ? <img src={url} alt="" draggable={false} /> : <FilmStrip weight="regular" aria-hidden="true" />}
            {recording.durationMs !== null && recording.status !== "recording" ? <span className="rl-thumb-len">{formatDuration(recording.durationMs)}</span> : null}
        </span>
    );
}
