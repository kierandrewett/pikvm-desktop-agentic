/**
 * The lifecycle of a side chat: a temporary conversation that lives inside another page (the Memory panel's chat,
 * the agent editor's preview). One implementation, so both behave the same:
 *
 * - create it when the host mounts (or when `key` changes, or on `retry`);
 * - keep it alive with the temporary-chat keepalive while it shows, and follow its socket events (`watch`: off
 *   when the host renders ConversationPane, which watches the chat itself; socket.watch is a set, not a count);
 * - delete it when the host unmounts, the key changes or a retry starts. A double mount (React strict mode)
 *   deletes the chat it no longer needs.
 *
 * The host renders the chat (thread/conversation-page.tsx ConversationPane) and owns its errors' wording.
 */
import { TEMPORARY_KEEPALIVE_MS } from "@pikvm/chat-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { socket } from "../../lib/socket";

export interface SideChat {
    /** The chat's id once it exists. */
    cid: string | null;
    /** Why the chat could not be created; null while it is fine or still starting. */
    error: unknown;
    /** Delete the current chat (if any) and create a new one. */
    retry: () => void;
}

export function useSideChat({
    create,
    end,
    key,
    enabled = true,
    watch = true,
}: {
    /** Create the chat; resolves with its id. */
    create: () => Promise<string>;
    /** Delete the chat. Failures are the host's to report. */
    end: (id: string) => Promise<unknown>;
    /** A new value starts a new chat (for example another agent). */
    key: string;
    /** False: no chat (and the current one is deleted). */
    enabled?: boolean;
    /** Follow the chat's socket events here. Default true. */
    watch?: boolean;
}): SideChat {
    const [cid, setCid] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [attempt, setAttempt] = useState(0);
    // The latest callbacks, so a new function identity on each render does not restart the chat.
    const calls = useRef({ create, end });
    calls.current = { create, end };

    useEffect(() => {
        if (!enabled) return;
        let gone = false;
        let id: string | undefined;
        setError(null);
        setCid(null);
        calls.current
            .create()
            .then((created) => {
                if (gone) return void calls.current.end(created);
                id = created;
                setCid(created);
            })
            .catch((e: unknown) => !gone && setError(e ?? new Error("unknown")));
        return () => {
            gone = true;
            setCid(null);
            if (id) void calls.current.end(id);
        };
    }, [key, attempt, enabled]);

    useEffect(() => {
        if (!cid) return;
        const timer = setInterval(
            () => void api.post(`/conversations/${cid}/keepalive`).catch(() => undefined),
            TEMPORARY_KEEPALIVE_MS,
        );
        const unwatch = watch ? socket.watch(cid) : undefined;
        return () => {
            clearInterval(timer);
            unwatch?.();
        };
    }, [cid, watch]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { cid, error, retry };
}
