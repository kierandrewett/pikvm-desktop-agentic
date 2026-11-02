import { afterEach, describe, expect, it, vi } from "vitest";

const trigger = vi.fn();
vi.mock("web-haptics", () => ({ WebHaptics: class { trigger = trigger; } }));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    trigger.mockClear();
});

describe("haptics", () => {
    it("does nothing where navigator.vibrate exists: the pointer sink already vibrates there", async () => {
        vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate: () => true }));
        const { buzz } = await import("./haptics");
        buzz();
        await new Promise((r) => setTimeout(r, 20));
        buzz();
        expect(trigger).not.toHaveBeenCalled();
    });

    it("on iOS (no vibrate) loads web-haptics on first use and taps from then on", async () => {
        vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate: undefined }));
        const { buzz } = await import("./haptics");
        buzz("light");
        await vi.waitFor(() => {
            buzz("medium");
            expect(trigger).toHaveBeenCalledWith("medium");
        });
    });
});
