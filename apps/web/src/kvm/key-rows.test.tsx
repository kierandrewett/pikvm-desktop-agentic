// Failure modes K6-K9 in FAILURE_MODES.md.

import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFieldFocus } from "./field-focus";
import { KeyRows } from "./key-rows";
import { hidFrame, openRig, renderWithSession } from "./test-support";

async function mount(over: { fnOpen?: boolean; moreOpen?: boolean } = {}) {
    const rig = await openRig();
    const focus = createFieldFocus(rig.clock);
    renderWithSession(
        rig,
        <KeyRows
            keyboard={rig.session.keyboard}
            focus={focus}
            fnOpen={over.fnOpen ?? false}
            moreOpen={over.moreOpen ?? false}
            onFn={() => {}}
            onMore={() => {}}
        />,
    );
    return rig;
}

const ctrl = () => screen.getByRole("button", { name: "Ctrl" });

describe("sticky modifiers", () => {
    it("K6: a tap arms the modifier and says so, and the next key goes out as a chord with it", async () => {
        const rig = await mount();
        fireEvent.click(ctrl());
        expect(ctrl()).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByRole("button", { name: "Escape" }));
        rig.clock.advance(1000);
        expect(rig.sent()).toEqual(["key ControlLeft:down", "key Escape:down", "key Escape:up", "key ControlLeft:up"]);
        expect(ctrl()).toHaveAttribute("aria-pressed", "false");
    });

    it("K6: a second quick tap locks it: still pressed after a key, with a mark colour alone could not give", async () => {
        const rig = await mount();
        fireEvent.click(ctrl());
        fireEvent.click(ctrl());
        expect(ctrl().querySelector(".kvm-key-lock")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Tab" }));
        rig.clock.advance(1000);
        expect(ctrl()).toHaveAttribute("aria-pressed", "true");
        expect(rig.sent()).toContain("key Tab:down");

        // Slowly: a third tap clears it.
        rig.clock.advance(1000);
        fireEvent.click(ctrl());
        expect(ctrl()).toHaveAttribute("aria-pressed", "false");
    });

    it("K9: a shortcut key folds an armed modifier in once, even when it names the same one", async () => {
        const rig = await mount({ moreOpen: true });
        fireEvent.click(ctrl());
        fireEvent.click(screen.getByRole("button", { name: "Ctrl+C" }));
        rig.clock.advance(1000);
        expect(rig.sent()).toEqual(["key ControlLeft:down", "key KeyC:down", "key KeyC:up", "key ControlLeft:up"]);
    });
});

describe("the Caps key", () => {
    it("K7: shows the target's LED, not the tap, and says when the Pi has not reported", async () => {
        const rig = await mount();
        const caps = () => screen.getByRole("button", { name: "Caps" });
        expect(caps()).toHaveAttribute("aria-pressed", "false");
        expect(caps().title).toMatch(/has not reported/);

        fireEvent.click(caps());
        rig.clock.advance(1000);
        expect(rig.sent()).toEqual(["key CapsLock:down", "key CapsLock:up"]);
        // The tap alone changes nothing on screen.
        expect(caps()).toHaveAttribute("aria-pressed", "false");

        await act(async () => {
            rig.hub.last.serverMessage(hidFrame({ keyboard: { leds: { caps: true } } }));
            await rig.clock.settle();
        });
        expect(caps()).toHaveAttribute("aria-pressed", "true");
        expect(caps().title).toBe("Caps Lock is on on the target");
    });
});

describe("input offline", () => {
    it("K21: every key is disabled while the HID socket is down, and comes back with it", async () => {
        const rig = await mount({ moreOpen: true });
        expect(screen.getByRole("button", { name: "Tab" })).toBeEnabled();
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        for (const name of ["Tab", "Ctrl", "Caps", "Fn", "More keys", "Ctrl+C"]) {
            expect(screen.getByRole("button", { name })).toBeDisabled();
        }
        await act(async () => {
            await rig.clock.advanceAsync(1300);
            rig.hub.last.serverOpen();
            await rig.clock.settle();
        });
        expect(screen.getByRole("button", { name: "Tab" })).toBeEnabled();
    });
});

describe("rows", () => {
    it("K8: the Fn block and the More block are separate groups that are drawn only when open", async () => {
        await mount({ fnOpen: true });
        expect(screen.getByRole("group", { name: "Function keys" })).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "More keys and shortcuts" })).toBeNull();
        expect(screen.getAllByRole("button", { name: /^F\d+$/ })).toHaveLength(12);
    });

    it("the More block carries the shortcuts a phone keyboard cannot type", async () => {
        await mount({ moreOpen: true });
        for (const name of ["Ctrl+Z", "Alt+Tab", "Alt+F4", "Win+D, show the desktop", "Win+R, run", "Win+L, lock the target", "C-A-D, send Ctrl+Alt+Del", "Page up", "Print screen", "Context menu key"]) {
            expect(screen.getByRole("button", { name })).toBeInTheDocument();
        }
    });
});
