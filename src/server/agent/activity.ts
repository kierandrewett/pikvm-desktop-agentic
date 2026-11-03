import type { AgentActivity } from "@pikvm/mcp";

/**
 * What the KVM tab shows about the agent: idle, working, waiting for approval, or released
 * because a person took over. One value, replaced whenever the Desk changes it, and listeners
 * told each time. The activity route streams it as server-sent events.
 */

export type ActivityUpdate = Omit<AgentActivity, "at">;

export interface ActivityFeed {
    current(): AgentActivity;
    subscribe(listener: (activity: AgentActivity) => void): () => void;
}

export interface ActivityStore extends ActivityFeed {
    /** Replace the value. An identical one (ignoring the time) is not a change and tells nobody. */
    set(update: ActivityUpdate): void;
}

function same(a: ActivityUpdate, b: ActivityUpdate): boolean {
    return (
        a.state === b.state &&
        a.conversationId === b.conversationId &&
        a.tool === b.tool &&
        a.reason === b.reason &&
        a.pointer?.fx === b.pointer?.fx &&
        a.pointer?.fy === b.pointer?.fy
    );
}

export function createActivity(now: () => number = Date.now): ActivityStore {
    let value: AgentActivity = { state: "idle", at: now() };
    const listeners = new Set<(activity: AgentActivity) => void>();
    return {
        current: () => value,
        set(update) {
            if (same(update, value)) return;
            value = { ...update, at: now() };
            for (const listener of [...listeners]) listener(value);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
