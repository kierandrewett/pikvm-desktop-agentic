/**
 * Output of slash commands answered by the agent runtime itself (`response.local`). It is not kept in
 * history, so each one is remembered here for the life of the tab and shown in the thread after the
 * turn that was last when it ran.
 */
import type { ResponseObject } from "@pikvm/chat-protocol";
import { useSyncExternalStore } from "react";

export interface LocalNotice {
    id: string;
    output: string;
    failed: boolean;
    /** Key of the thread entry it follows ("" when the thread was empty). */
    anchor: string;
}

const EMPTY: LocalNotice[] = [];
const store = new Map<string, LocalNotice[]>();
const subs = new Set<() => void>();

/** Text without terminal colour codes (the escape byte may already be gone). */
export const stripAnsi = (s: string) => s.replace(/\u001b?\[[0-9;]*m/g, "");

/** Plain text of a response's messages, without terminal colour codes. */
export function localOutput(r: Pick<ResponseObject, "output">): string {
    return stripAnsi(
        r.output
            .flatMap((it) => (it.type === "message" ? it.content.map((c) => ("text" in c ? c.text : "")) : []))
            .join("\n"),
    ).trim();
}

export function addLocalNotice(conversationId: string, n: LocalNotice): void {
    const list = store.get(conversationId) ?? EMPTY;
    if (list.some((x) => x.id === n.id)) return;
    store.set(conversationId, [...list, n]);
    for (const fn of subs) fn();
}

export function useLocalNotices(conversationId: string): LocalNotice[] {
    return useSyncExternalStore(
        (fn) => {
            subs.add(fn);
            return () => subs.delete(fn);
        },
        () => store.get(conversationId) ?? EMPTY,
    );
}
