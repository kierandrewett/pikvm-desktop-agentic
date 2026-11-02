/**
 * FAILURE MODES (written before the tests)
 *
 *  A1. The desktop app forwards the window's own key events to the target. With the KVM mounted
 *      behind another tab, a key typed on Settings or Chat (anywhere that is not a text field)
 *      would be typed at the target.
 *  A2. Putting the KVM back in front leaves the forwarding dead (it was unbound and not rebound).
 *  A3. Changing tab rebinds the handlers, which lets go of the held keys through the unbind and
 *      then binds again: it must be one release, from the change itself, and the handlers must
 *      stay bound for the return.
 *  A4. The tab changing with a key down leaves it down on the target.
 *  A5. The hidden field keeps focus (and with it the soft keyboard) when another tab comes up.
 *  A6. The host paste shortcut typed on another tab pastes the clipboard at the target.
 */

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvmActiveProvider } from "./active";
import { createFieldFocus } from "./field-focus";
import { KeyboardInput } from "./keyboard-input";
import { openRig } from "./test-support";

afterEach(() => {
    vi.unstubAllGlobals();
});

const keydown = (code: string, key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init });

async function mount(active: boolean) {
    const rig = await openRig();
    const focus = createFieldFocus(rig.clock);
    const view = (isActive: boolean) => (
        <KvmActiveProvider value={isActive}>
            <KeyboardInput session={rig.session} focus={focus} desktop />
        </KvmActiveProvider>
    );
    const rendered = render(view(active));
    const settle = async () => {
        await act(async () => {
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
    };
    return { rig, focus, settle, setActive: (next: boolean) => rendered.rerender(view(next)) };
}

describe("the desktop app's window-level forwarding", () => {
    it("A1: forwards a key while the KVM is in front", async () => {
        const { rig, settle } = await mount(true);
        document.body.dispatchEvent(keydown("F5", "F5"));
        await settle();
        expect(rig.sent()).toEqual(["key F5:down", "key F5:up"]);
    });

    it("A1: ignores the same key while another tab is in front", async () => {
        const { rig, settle } = await mount(false);
        document.body.dispatchEvent(keydown("F5", "F5"));
        await settle();
        expect(rig.sent()).toEqual([]);
    });

    it("A2/A3: forwards again on return, with the handlers bound all along", async () => {
        const { rig, settle, setActive } = await mount(true);
        setActive(false);
        document.body.dispatchEvent(keydown("F5", "F5"));
        await settle();
        expect(rig.sent()).toEqual([]);

        setActive(true);
        document.body.dispatchEvent(keydown("F5", "F5"));
        await settle();
        expect(rig.sent()).toEqual(["key F5:down", "key F5:up"]);
    });

    it("A6: does not paste the host clipboard for Ctrl+V typed on another tab", async () => {
        const readText = vi.fn(async () => "secret");
        vi.stubGlobal("navigator", Object.assign(Object.create(Object.getPrototypeOf(navigator)), { clipboard: { readText } }));
        const { rig, settle } = await mount(false);
        document.body.dispatchEvent(keydown("KeyV", "v", { ctrlKey: true }));
        await settle();
        expect(readText).not.toHaveBeenCalled();
        expect(rig.sent()).toEqual([]);
    });
});

describe("leaving the KVM", () => {
    it("A4: lets go of a held modifier, once", async () => {
        const { rig, setActive } = await mount(true);
        document.body.dispatchEvent(keydown("ShiftLeft", "Shift", { shiftKey: true }));
        expect(rig.sent()).toEqual(["key ShiftLeft:down"]);

        setActive(false);
        expect(rig.sent()).toEqual(["key ShiftLeft:down", "key ShiftLeft:up"]);
    });

    it("A5: puts the soft keyboard away", async () => {
        const { focus, setActive } = await mount(true);
        focus.focus();
        expect(document.activeElement).toBe(document.querySelector(".kvm-kbd"));

        setActive(false);
        expect(document.activeElement).not.toBe(document.querySelector(".kvm-kbd"));
        expect(focus.store.getState().focused).toBe(false);
    });
});
