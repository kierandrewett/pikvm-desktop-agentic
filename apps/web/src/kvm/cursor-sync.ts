/**
 * The shared cursor, as this page hears it: one server-sent stream from the host with where the target's pointer is,
 * whoever moved it. This page's own moves come back on it too, named with this page's id, so they can be told apart
 * and ignored; everything else is another page's or the agent's.
 *
 * It decides nothing about the cursor. The pointer machine takes an update when this page is idle and holds it while
 * a finger or the mouse is at work (see `PointerMachine.onRemote`); this only delivers them in order, once each, and
 * asks the host for the current position again whenever the page could have missed some.
 */

import { CURSOR_PATH, CursorUpdate } from "@pikvm/contracts/api";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(CursorUpdate);

/** A position from the host, and whether this page moved it. */
export interface CursorEvent extends CursorUpdate {
    readonly own: boolean;
}

export interface CursorSync {
    /** Names this page on its input socket and on every update it causes. */
    readonly clientId: string;
    /** Open the stream (while the page is shown). Idempotent. */
    start(): void;
    stop(): void;
    /** The newest update from anyone, or null while the host has none. */
    latest(): CursorEvent | null;
    /** Told of each update, in order, the newest one at once. Returns how to stop. */
    subscribe(listener: (event: CursorEvent) => void): () => void;
}

/** What of EventSource this reads, so a test can bring its own. */
export interface StreamSource {
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: ((event: Event) => void) | null;
    close(): void;
}

/** What of the document this reads: whether the page is shown, and when that changes. */
export interface PageVisibility {
    readonly hidden: boolean;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface CursorSyncOptions {
    readonly clientId?: string;
    /** Opens the stream; the browser's EventSource by default, and none where there is no EventSource. */
    readonly open?: (url: string) => StreamSource;
    /** Defaults to the page's document; a page that is hidden holds no stream. */
    readonly document?: PageVisibility;
}

/** A page id: random, and plain letters and digits, which is what the host takes off the socket URL. */
export function newClientId(): string {
    const bytes = new Uint8Array(9);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return `pg-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createCursorSync(options: CursorSyncOptions = {}): CursorSync {
    const clientId = options.clientId ?? newClientId();
    const open =
        options.open ??
        (typeof EventSource === "undefined" ? undefined : (url: string): StreamSource => new EventSource(url));
    const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
    const listeners = new Set<(event: CursorEvent) => void>();

    let started = false;
    let source: StreamSource | null = null;
    let newest: CursorEvent | null = null;
    // The highest sequence number taken from this connection; a new connection starts again (the host may have restarted).
    let seen = -1;

    const close = (): void => {
        source?.close();
        source = null;
    };

    const connect = (): void => {
        if (!started || source || !open || doc?.hidden) return;
        const stream = open(CURSOR_PATH);
        source = stream;
        seen = -1;
        stream.onmessage = (message) => {
            if (source !== stream) return;
            let update: CursorUpdate;
            try {
                update = decode(JSON.parse(message.data));
            } catch {
                return;
            }
            // In order and once each: a repeat or a straggler is not news.
            if (update.seq <= seen) return;
            seen = update.seq;
            const event: CursorEvent = { ...update, own: update.source === clientId };
            newest = event;
            for (const listener of [...listeners]) listener(event);
        };
        // The browser reconnects by itself, and the host then sends the current position first; until it does, start the count again.
        stream.onerror = () => {
            if (source === stream) seen = -1;
        };
    };

    // A page in the background is not drawing a cursor, and a phone that was asleep has missed updates:
    // let go of the stream while hidden and take a fresh one, which begins with the current position, when shown.
    const onVisibility = (): void => {
        if (doc?.hidden) close();
        else connect();
    };

    return {
        clientId,
        start() {
            if (started) return;
            started = true;
            doc?.addEventListener("visibilitychange", onVisibility);
            connect();
        },
        stop() {
            started = false;
            doc?.removeEventListener("visibilitychange", onVisibility);
            close();
        },
        latest: () => newest,
        subscribe(listener) {
            listeners.add(listener);
            if (newest) listener(newest);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
