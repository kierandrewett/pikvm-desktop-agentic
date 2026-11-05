import { PRESENCE_EXPIRY_MS, USER_ACTIVE_WINDOW_MS } from "./limits";

/**
 * Whether the person is at the screen right now, from what the app's pages report: a page that has focus and has seen REAL keyboard or
 * pointer input lately. The page decides what is real (a trusted DOM event, never the HID the host itself sends: the jiggler, the
 * agent and macros reach the target through the same path and must not count) and reports only ages, never a key, a coordinate or text.
 *
 * A report is kept per client (a random id per page) and expires after `PRESENCE_EXPIRY_MS` without another, so a closed tab or a
 * crashed app cannot hold a notification back. Ages are turned into host time at the moment a report arrives, so the clocks of the
 * page and the host never meet.
 */

export interface PresenceReport {
    /** The page is visible and has focus. */
    focused: boolean;
    /** How long ago the last real keydown was, ms; null when there has been none. */
    keyboardAgoMs: number | null;
    /** How long ago the last significant pointer movement was, ms; null when there has been none. */
    pointerAgoMs: number | null;
}

interface Record {
    receivedAt: number;
    focused: boolean;
    keyboardAt: number | null;
    pointerAt: number | null;
}

export interface Presence {
    report(userId: string, clientId: string, report: PresenceReport): void;
    /** At least one client is focused and had real input inside the window, and has reported lately enough to still be there. */
    active(userId: string): boolean;
}

export function createPresence(now: () => number): Presence {
    const clients = new Map<string, Map<string, Record>>();

    return {
        report(userId, clientId, report) {
            const at = now();
            const mine = clients.get(userId) ?? new Map<string, Record>();
            clients.set(userId, mine);
            mine.set(clientId, {
                receivedAt: at,
                focused: report.focused,
                keyboardAt: report.keyboardAgoMs === null ? null : at - report.keyboardAgoMs,
                pointerAt: report.pointerAgoMs === null ? null : at - report.pointerAgoMs,
            });
        },

        active(userId) {
            const at = now();
            const mine = clients.get(userId);
            if (!mine) return false;
            let found = false;
            for (const [id, record] of mine) {
                if (at - record.receivedAt >= PRESENCE_EXPIRY_MS) {
                    mine.delete(id);
                    continue;
                }
                const recent = (when: number | null): boolean => when !== null && at - when < USER_ACTIVE_WINDOW_MS;
                if (record.focused && (recent(record.keyboardAt) || recent(record.pointerAt))) found = true;
            }
            if (mine.size === 0) clients.delete(userId);
            return found;
        },
    };
}
