import { describe, expect, it } from "vitest";
import { applyFrame, CAPS_PENDING_MS, capsPending, initialDeviceState, noteCapsToggle, type DeviceState } from "./device-state";

// Failure modes 14-17, 19 in FAILURE_MODES.md.

const frame = (event_type: string, event: unknown): unknown => ({ event_type, event });
const fold = (frames: unknown[], from: DeviceState = initialDeviceState, now = 0): DeviceState =>
    frames.reduce<DeviceState>((s, f) => applyFrame(s, f, now), from);

describe("atx", () => {
    it("merges deltas instead of replacing", () => {
        const s = fold([
            frame("atx", { enabled: true, busy: false, leds: { power: true, hdd: false } }),
            frame("atx", { busy: true }),
        ]);
        expect(s.atx).toEqual({ enabled: true, busy: true, leds: { power: true, hdd: false } });
    });

    it("replaces leds wholesale when they are sent, and tolerates null leds", () => {
        const s = fold([frame("atx", { leds: { power: true } }), frame("atx", { leds: null })]);
        expect(s.atx?.leds).toEqual({});
    });

    it("an event with no body resets the module", () => {
        const s = fold([frame("atx", { enabled: true }), { event_type: "atx" }]);
        expect(s.atx).toBeNull();
    });

    it("does not mutate the previous state object", () => {
        const a = fold([frame("atx", { enabled: true })]);
        const snapshot = JSON.stringify(a);
        applyFrame(a, frame("atx", { enabled: false }), 0);
        expect(JSON.stringify(a)).toBe(snapshot);
    });
});

describe("msd", () => {
    it("keeps storage fields a delta did not repeat", () => {
        const s = fold([
            frame("msd", { enabled: true, online: true, storage: { images: { a: 1 }, parts: { "": 5 } }, drive: { image: "a" } }),
            frame("msd", { storage: { uploading: { name: "b" } } }),
            frame("msd", { busy: true }),
        ]);
        expect(s.msd).toMatchObject({
            enabled: true,
            online: true,
            busy: true,
            drive: { image: "a" },
            storage: { images: { a: 1 }, parts: { "": 5 }, uploading: { name: "b" } },
        });
    });

    it("a falsy drive does not clear the known one (console parity)", () => {
        const s = fold([frame("msd", { drive: { image: "a" } }), frame("msd", { drive: null })]);
        expect(s.msd?.drive).toEqual({ image: "a" });
    });

    it("starts with an empty storage object so readers never null-check it", () => {
        expect(fold([frame("msd", { enabled: false })]).msd?.storage).toEqual({});
    });
});

describe("info, hid status, gpio", () => {
    it("info merges health, fan, system and node independently", () => {
        const s = fold([frame("info", { health: { a: 1 }, system: { v: "1" } }), frame("info", { fan: { x: 1 } })]);
        expect(s.info).toEqual({ health: { a: 1 }, system: { v: "1" }, fan: { x: 1 } });
    });

    it("hid status keeps busy, which used to be dropped", () => {
        const s = fold([frame("hid", { online: true, connected: true, busy: false }), frame("hid", { busy: true })]);
        expect(s.hid).toEqual({ online: true, connected: true, busy: true });
    });

    it("gpio replaces model and state separately", () => {
        const s = fold([frame("gpio", { model: { m: 1 }, state: { s: 1 } }), frame("gpio", { state: { s: 2 } })]);
        expect(s.gpio).toEqual({ model: { m: 1 }, state: { s: 2 } });
    });

    it("gpio with no body changes nothing", () => {
        const s = fold([frame("gpio", { model: 1 })]);
        expect(applyFrame(s, { event_type: "gpio" }, 0)).toBe(s);
    });
});

describe("streamer and ocr", () => {
    it("limits travel with features; features without limits clears them", () => {
        const s1 = fold([frame("streamer", { features: { quality: true }, limits: { max: 5 } })]);
        expect(s1.streamer).toMatchObject({ features: { quality: true }, limits: { max: 5 } });
        const s2 = applyFrame(s1, frame("streamer", { features: { quality: false } }), 0);
        expect(s2.streamer.limits).toBeNull();
    });

    it("applied updates alone and leaves features and limits", () => {
        const s = fold([
            frame("streamer", { features: { q: 1 }, limits: { l: 1 } }),
            frame("streamer", { applied: { quality: 80 } }),
        ]);
        expect(s.streamer).toEqual({ features: { q: 1 }, limits: { l: 1 }, applied: { quality: 80 } });
    });

    it("the source flag is taken from streamer.source and survives events without it", () => {
        const s = fold([frame("streamer", { streamer: { source: { online: false } } }), frame("streamer", { applied: {} })]);
        expect(s.streamerSource).toEqual({ online: false });
        const cleared = applyFrame(s, frame("streamer", { streamer: {} }), 0);
        expect(cleared.streamerSource).toBeNull();
    });

    it("ocr is replaced whole and enabled is coerced", () => {
        const s = fold([frame("ocr", { enabled: 1, langs: { default: ["eng"] } })]);
        expect(s.ocr).toEqual({ enabled: true, langs: { default: ["eng"] } });
        expect(fold([frame("ocr", { enabled: false })]).ocr).toEqual({ enabled: false, langs: null });
    });
});

describe("keymaps (failure mode 19)", () => {
    it("stores a map-shaped available untouched", () => {
        const keymaps = { default: "en-us", available: { "en-us": {}, "en-gb": {} } };
        expect(fold([frame("hid_keymaps", { keymaps })]).keymaps).toBe(keymaps);
    });

    it("stores a list-shaped available untouched", () => {
        const keymaps = { default: "en-us", available: ["en-us", "de"] };
        expect(fold([frame("hid_keymaps", { keymaps })]).keymaps).toBe(keymaps);
    });

    it("ignores an event without keymaps", () => {
        const s = fold([frame("hid_keymaps", { keymaps: { default: "x" } })]);
        expect(applyFrame(s, frame("hid_keymaps", {}), 0)).toBe(s);
    });
});

describe("caps lock", () => {
    const caps = (on: boolean) => frame("hid", { keyboard: { leds: { caps: on } } });

    it("is unknown until the Pi reports, then known", () => {
        expect(initialDeviceState.caps.known).toBe(false);
        const s = fold([caps(true)]);
        expect(s.caps).toMatchObject({ known: true, on: true });
    });

    it("reads leds from the top level of the event too, and from any event type", () => {
        expect(fold([frame("hid", { leds: { caps: true } })]).caps.on).toBe(true);
        expect(fold([frame("something_else", { leds: { caps: true } })]).caps.on).toBe(true);
    });

    it("noteCapsToggle from an unknown state does nothing", () => {
        expect(noteCapsToggle(initialDeviceState, 0)).toBe(initialDeviceState);
    });

    it("a toggle flips the expectation and opens the pending window", () => {
        const s = noteCapsToggle(fold([caps(false)]), 1000);
        expect(s.caps.on).toBe(true);
        expect(capsPending(s, 1000 + CAPS_PENDING_MS - 1)).toBe(true);
        expect(capsPending(s, 1000 + CAPS_PENDING_MS)).toBe(false);
    });

    it("a report that disagrees with a toggle in flight is the pre-toggle one and is ignored", () => {
        const toggled = noteCapsToggle(fold([caps(false)]), 1000); // expects on
        const stale = applyFrame(toggled, caps(false), 1500);
        expect(stale.caps.on).toBe(true);
        expect(capsPending(stale, 1500)).toBe(true);
    });

    it("the confirming report closes the pending window", () => {
        const toggled = noteCapsToggle(fold([caps(false)]), 1000);
        const confirmed = applyFrame(toggled, caps(true), 1500);
        expect(confirmed.caps.on).toBe(true);
        expect(capsPending(confirmed, 1500)).toBe(false);
    });

    it("after the window, a disagreeing report wins (the toggle never landed)", () => {
        const toggled = noteCapsToggle(fold([caps(false)]), 1000);
        const late = applyFrame(toggled, caps(false), 1000 + CAPS_PENDING_MS + 1);
        expect(late.caps.on).toBe(false);
    });

    it("num and scroll are tracked independently and kept when absent", () => {
        const s = fold([frame("hid", { keyboard: { leds: { num: true } } }), frame("hid", { keyboard: { leds: { scroll: false } } })]);
        expect(s.leds).toEqual({ num: true, scroll: false });
    });
});

describe("mouse mode (failure mode 17)", () => {
    it("is unknown until reported", () => {
        expect(initialDeviceState.mouse.absolute).toBeNull();
    });

    it("keeps fields a delta omits", () => {
        const s = fold([
            frame("hid", { mouse: { absolute: true, outputs: { available: ["usb", "usb_rel"], active: "usb" } } }),
            frame("hid", { mouse: { outputs: { active: "usb" } } }),
        ]);
        expect(s.mouse).toEqual({ absolute: true, outputs: ["usb", "usb_rel"] });
    });

    it("an explicit absolute flag flips the mode", () => {
        const s = fold([frame("hid", { mouse: { absolute: true } }), frame("hid", { mouse: { absolute: false } })]);
        expect(s.mouse.absolute).toBe(false);
    });

    it("falls back to the active output name only while unknown", () => {
        const s = fold([frame("hid", { mouse: { outputs: { active: "usb_rel" } } })]);
        expect(s.mouse.absolute).toBe(false);
        const known = fold([frame("hid", { mouse: { absolute: true, outputs: { active: "usb_rel" } } })]);
        expect(known.mouse.absolute).toBe(true);
    });

    it("returns the same state when nothing changed", () => {
        const s = fold([frame("hid", { mouse: { absolute: true } })]);
        expect(applyFrame(s, frame("hid", { mouse: { absolute: true } }), 0).mouse).toBe(s.mouse);
    });
});

describe("malformed frames", () => {
    it.each([null, undefined, 3, "x", [], {}, { event_type: "hid" }, { event_type: "hid", event: "x" }])(
        "%j changes nothing",
        (f) => {
            expect(applyFrame(initialDeviceState, f, 0).caps).toBe(initialDeviceState.caps);
            expect(applyFrame(initialDeviceState, f, 0).mouse).toBe(initialDeviceState.mouse);
        },
    );

    it("an unknown event type with an unrelated body changes nothing", () => {
        expect(applyFrame(initialDeviceState, frame("loop", {}), 0)).toBe(initialDeviceState);
    });
});
