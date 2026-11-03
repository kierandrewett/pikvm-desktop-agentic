/**
 * Render-time context for markdown components. The parsed element tree is cached by text, so anything
 * that varies per message or per conversation (streaming state, known sources) reaches the components
 * through context instead of the parse, and a cached tree stays valid.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../../lib/queries";
import { registerSessionReset } from "../../../lib/session-reset";

export interface MdEnvValue {
    /** The message is still streaming: no collapsing, no layout-changing decisions. */
    streaming: boolean;
    /** Inherit the message owner even if React mounts a child after an account reset. */
    ownerEpoch?: number;
}

export const MdEnv = createContext<MdEnvValue>({ streaming: false });

/** Copy text to the clipboard and show a check for 2s. */
export function useCopy(): [boolean, (text: string) => void] {
    const env = useContext(MdEnv);
    const [ownerEpoch] = useState(() => env.ownerEpoch ?? captureSessionEpoch());
    const [copied, setCopied] = useState(false);
    const alive = useRef(false);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);
    useEffect(() => {
        if (!copied || !isSessionEpochCurrent(ownerEpoch)) return;
        const t = setTimeout(() => {
            if (alive.current && isSessionEpochCurrent(ownerEpoch)) setCopied(false);
        }, 2000);
        return () => clearTimeout(t);
    }, [copied, ownerEpoch]);
    return [
        isSessionEpochCurrent(ownerEpoch) && copied,
        (text: string) => {
            if (!alive.current || !isSessionEpochCurrent(ownerEpoch)) return;
            void navigator.clipboard
                ?.writeText(text)
                .then(() => {
                    if (alive.current && isSessionEpochCurrent(ownerEpoch)) setCopied(true);
                })
                .catch(() => {
                    if (alive.current && isSessionEpochCurrent(ownerEpoch)) setCopied(false);
                });
        },
    ];
}

/**
 * Cooperative work queue for post-render jobs (KaTeX typesetting, syntax highlighting). Many blocks in one
 * message ask for work at the same moment; running them in one microtask flush would be one long task.
 * Jobs run one after another in macrotasks, at most `BUDGET_MS` of work per task, so input and paint get
 * a turn in between.
 */
const BUDGET_MS = 8;
export type WorkOutcome<T> = { status: "completed"; value: T } | { status: "cancelled" };

interface WorkEntry {
    run: () => void;
    cancel: () => void;
}

const queue: WorkEntry[] = [];
registerSessionReset("markdown-work-queue", () => {
    // Detach old ownership first. Re-entrant scheduling must keep the new queue and its posted wake.
    const pending = queue.splice(0);
    for (const entry of pending) entry.cancel();
});
let scheduled = false;
const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : undefined;

function drain() {
    scheduled = false;
    const until = performance.now() + BUDGET_MS;
    while (queue.length && performance.now() < until) queue.shift()!.run();
    if (queue.length) kick();
}

function kick() {
    if (scheduled) return;
    scheduled = true;
    if (channel) channel.port2.postMessage(0);
    else setTimeout(drain, 0);
}
if (channel) channel.port1.onmessage = drain;

/** Run a synchronous job in a later task. Account reset cancels pending work and settles its promise. */
export function schedule<T>(job: () => T, ownerEpoch: number): Promise<WorkOutcome<T>> {
    if (!isSessionEpochCurrent(ownerEpoch)) return Promise.resolve({ status: "cancelled" });
    return new Promise((resolve, reject) => {
        const cancel = () => resolve({ status: "cancelled" });
        queue.push({
            cancel,
            run: () => {
                if (!isSessionEpochCurrent(ownerEpoch)) {
                    cancel();
                    return;
                }
                try {
                    const value = job();
                    if (!isSessionEpochCurrent(ownerEpoch)) cancel();
                    else resolve({ status: "completed", value });
                } catch (error) {
                    reject(error);
                }
            },
        });
        kick();
    });
}
