/**
 * The web side of "the screen changed while nobody was looking".
 *
 * Failure modes, before behaviour:
 *  A1. An alert fires for a window that is being looked at (a notification for the thing in front of you).
 *  A2. Alerts stack the marker on the title ("● ● PiKVM"), and restoring it leaves a mark behind.
 *  A3. The marker, badge or notification outlives the moment the window is looked at again.
 *  A4. Restoring the title clobbers a title the app set in the meantime.
 *  A5. A browser without the badge API, a refused badge, or a notification that throws, breaks the alert.
 *  A6. A notification is shown without the user's permission, or the permission prompt appears for a browser that has none.
 *  A7. Clicking the notification does not bring the window forward.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { alertPermission, askForAlertPermission, ATTENTION_MARK, ATTENTION_TEXT, createWebAttention, type AttentionHost, type NotificationLike } from "./attention";

function setup(over: { hidden?: boolean; focused?: boolean; badge?: boolean; notify?: boolean } = {}) {
    const doc = new EventTarget() as EventTarget & { title: string; hidden: boolean; hasFocus(): boolean; focused: boolean };
    doc.title = "PiKVM";
    doc.hidden = over.hidden ?? true;
    doc.focused = over.focused ?? false;
    doc.hasFocus = () => doc.focused;
    const win = Object.assign(new EventTarget(), { focus: vi.fn() });
    const notes: Array<NotificationLike & { title: string; body: string; close: ReturnType<typeof vi.fn> }> = [];
    const badge = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const host: AttentionHost = {
        document: doc,
        window: win,
        ...(over.badge === false ? {} : { badge }),
        ...(over.notify === false
            ? {}
            : {
                  notify: (title: string, body: string) => {
                      const note = { title, body, onclick: null, close: vi.fn() };
                      notes.push(note);
                      return note;
                  },
              }),
    };
    const attention = createWebAttention(host);
    const see = (): void => {
        doc.hidden = false;
        doc.focused = true;
        win.dispatchEvent(new Event("focus"));
    };
    return { doc, win, notes, badge, attention, see };
}

describe("web attention", () => {
    it("A1: says nothing for a window that is in front and focused", () => {
        const { attention, doc, notes, badge } = setup({ hidden: false, focused: true });
        attention.requestAttention();
        expect(doc.title).toBe("PiKVM");
        expect(notes).toHaveLength(0);
        expect(badge.set).not.toHaveBeenCalled();
    });

    it("marks the title, sets the badge and notifies when the window is in the background", () => {
        const { attention, doc, notes, badge } = setup();
        attention.requestAttention();
        expect(doc.title).toBe(`${ATTENTION_MARK}PiKVM`);
        expect(badge.set).toHaveBeenCalledTimes(1);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ title: "PiKVM", body: ATTENTION_TEXT });
    });

    it("also counts a visible window that another window has the focus of", () => {
        const { attention, doc } = setup({ hidden: false, focused: false });
        attention.requestAttention();
        expect(doc.title).toBe(`${ATTENTION_MARK}PiKVM`);
    });

    it("A2: a second alert does not stack the marker, and the first notification is replaced", () => {
        const { attention, doc, notes } = setup();
        attention.requestAttention();
        attention.requestAttention();
        expect(doc.title).toBe(`${ATTENTION_MARK}PiKVM`);
        expect(notes).toHaveLength(2);
        expect(notes[0]?.close).toHaveBeenCalledTimes(1);
        expect(notes[1]?.close).not.toHaveBeenCalled();
    });

    it("A3: looking at the window again clears the title, the badge and the notification", () => {
        const { attention, doc, notes, badge, see } = setup();
        attention.requestAttention();
        see();
        expect(doc.title).toBe("PiKVM");
        expect(badge.clear).toHaveBeenCalledTimes(1);
        expect(notes[0]?.close).toHaveBeenCalledTimes(1);
        // And an unrelated focus later does nothing more.
        see();
        expect(badge.clear).toHaveBeenCalledTimes(1);
    });

    it("A3: becoming visible without the focus is not yet being looked at", () => {
        const { attention, doc } = setup();
        attention.requestAttention();
        doc.hidden = false;
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(doc.title).toBe(`${ATTENTION_MARK}PiKVM`);
        doc.focused = true;
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(doc.title).toBe("PiKVM");
    });

    it("A4: a title the app set since is left alone", () => {
        const { attention, doc, see } = setup();
        attention.requestAttention();
        doc.title = "PiKVM - Settings";
        see();
        expect(doc.title).toBe("PiKVM - Settings");
    });

    it("A5: no badge API, a refused badge and a notification that cannot be made are not errors", async () => {
        const bare = setup({ badge: false, notify: false });
        expect(() => bare.attention.requestAttention()).not.toThrow();
        expect(bare.doc.title).toBe(`${ATTENTION_MARK}PiKVM`);

        const refusing = setup();
        refusing.badge.set.mockRejectedValue(new Error("no"));
        refusing.badge.clear.mockRejectedValue(new Error("no"));
        refusing.attention.requestAttention();
        refusing.see();
        await Promise.resolve();
        expect(refusing.doc.title).toBe("PiKVM");
    });

    it("A7: clicking the notification focuses the window and clears the alert", () => {
        const { attention, win, notes, doc } = setup();
        attention.requestAttention();
        notes[0]?.onclick?.(new Event("click"));
        expect(win.focus).toHaveBeenCalledTimes(1);
        expect(doc.title).toBe("PiKVM");
    });

    it("dispose stops listening and clears what is showing", () => {
        const { attention, doc, badge } = setup();
        attention.requestAttention();
        attention.dispose();
        expect(doc.title).toBe("PiKVM");
        expect(badge.clear).toHaveBeenCalledTimes(1);
    });
});

describe("notification permission", () => {
    const original = Reflect.get(globalThis, "Notification");
    afterEach(() => {
        if (original === undefined) Reflect.deleteProperty(globalThis, "Notification");
        else Reflect.set(globalThis, "Notification", original);
    });

    it("A6: a browser with no Notification is reported as unsupported and asks for nothing", async () => {
        Reflect.deleteProperty(globalThis, "Notification");
        expect(alertPermission()).toBe("unsupported");
        expect(await askForAlertPermission()).toBe("unsupported");
    });

    it("A6: asks only while undecided, and a prompt that throws leaves it undecided", async () => {
        const requestPermission = vi.fn(async () => "granted");
        Reflect.set(globalThis, "Notification", { permission: "default", requestPermission });
        expect(await askForAlertPermission()).toBe("granted");
        expect(requestPermission).toHaveBeenCalledTimes(1);

        Reflect.set(globalThis, "Notification", { permission: "denied", requestPermission });
        expect(await askForAlertPermission()).toBe("denied");
        expect(requestPermission).toHaveBeenCalledTimes(1);

        Reflect.set(globalThis, "Notification", {
            permission: "default",
            requestPermission: async () => Promise.reject(new Error("blocked")),
        });
        expect(await askForAlertPermission()).toBe("default");
    });
});
