// Failure modes 1-12 in FAILURE_MODES.md.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { status } from "@pikvm/kvm-engine/testing";
import { describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "../../test/harness";
import { AtxPowerDialog, AtxResetDialog } from "./atx-dialog";
import { PasteDialog } from "./paste-dialog";
import { mountDialog, openRig, pi } from "./test-rig";
import { Btn, DialogShell, useConfirm } from "./shell";

installMatchMedia({ compact: false });

function Host({ onClose }: { onClose: () => void }) {
    const confirm = useConfirm();
    return (
        <>
            <DialogShell title="Host" onClose={onClose} actions={<Btn onClick={() => void confirm.ask({ title: "Sure?", body: "Really.", confirm: "Yes" })}>Ask</Btn>}>
                <input aria-label="field" />
            </DialogShell>
            {confirm.element}
        </>
    );
}

describe("shell (1-5)", () => {
    it("1: a confirmation above a dialog takes Escape first; the dialog keeps its own", async () => {
        const onClose = vi.fn();
        render(<Host onClose={onClose} />);
        fireEvent.click(screen.getByRole("button", { name: "Ask" }));
        const sure = screen.getByRole("alertdialog", { name: "Sure?" });
        expect(sure).toBeInTheDocument();
        // Cancel has the focus: Enter or a stray double tap answers "no".
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        // And now Escape is the dialog's.
        fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("2: keys typed in a dialog never reach document listeners (the KVM forwarder)", async () => {
        render(<Host onClose={() => {}} />);
        const seen: string[] = [];
        const spy = (e: KeyboardEvent): void => void seen.push(`${e.type}:${e.key}`);
        document.addEventListener("keydown", spy);
        document.addEventListener("keyup", spy);
        const field = screen.getByLabelText("field");
        await userEvent.type(field, "ab");
        document.removeEventListener("keydown", spy);
        document.removeEventListener("keyup", spy);
        expect(seen).toEqual([]);
        expect(field).toHaveValue("ab");
    });

    it("3: Tab wraps inside the panel, and focus returns to the opener on close", async () => {
        const opener = document.createElement("button");
        document.body.appendChild(opener);
        opener.focus();
        const view = render(<Host onClose={() => {}} />);
        const field = screen.getByLabelText("field");
        const ask = screen.getByRole("button", { name: "Ask" });
        expect(field).toHaveFocus();
        ask.focus();
        fireEvent.keyDown(ask, { key: "Tab" });
        expect(field).toHaveFocus();
        fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
        expect(ask).toHaveFocus();
        view.unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });

    it("3: focus that wandered out is pulled back in", async () => {
        const outside = document.createElement("input");
        document.body.appendChild(outside);
        render(<Host onClose={() => {}} />);
        outside.focus();
        expect(screen.getByLabelText("field")).toHaveFocus();
        outside.remove();
    });

    it("4: only a press that starts on the backdrop closes", async () => {
        const onClose = vi.fn();
        render(<Host onClose={onClose} />);
        const scrim = document.querySelector(".dlg-scrim") as HTMLElement;
        const field = screen.getByLabelText("field");
        // Select text in the field and release over the backdrop: not a dismissal.
        fireEvent.pointerDown(field);
        fireEvent.pointerUp(scrim);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.pointerDown(scrim);
        fireEvent.pointerUp(scrim);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe("ATX confirmation (6-8)", () => {
    it("6: nothing is sent until Confirm, Cancel has the focus, and it says what it costs", async () => {
        const rig = await openRig();
        pi(rig, "atx", { enabled: true, busy: false, leds: { power: true, hdd: false } });
        const view = await mountDialog(AtxResetDialog, rig);
        expect(screen.getByRole("alertdialog", { name: "Press the reset button?" })).toBeInTheDocument();
        expect(screen.getByText(/Unsaved work will be lost/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        expect(rig.http.requests).toEqual([]);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(view.closed.count).toBe(1);
        expect(rig.http.requests).toEqual([]);
    });

    it("6: Confirm presses reset through kvmd, closes and says so", async () => {
        const rig = await openRig();
        pi(rig, "atx", { enabled: true, busy: false, leds: { power: true } });
        rig.session.dialogs.open("atx-reset");
        const view = await mountDialog(AtxResetDialog, rig);
        fireEvent.click(screen.getByRole("button", { name: "Reset" }));
        await waitFor(() => expect(view.closed.count).toBe(1));
        expect(rig.http.requests).toEqual([{ method: "POST", path: "/api/atx/click?button=reset" }]);
        expect(rig.session.notices.store.getState().text).toBe("Reset pressed");
    });

    it("7: a second tap while the request runs sends nothing more", async () => {
        const rig = await openRig();
        pi(rig, "atx", { enabled: true, busy: false, leds: {} });
        const gate = Promise.withResolvers<{ ok: boolean; status: number }>();
        rig.http.respond = () => gate.promise;
        await mountDialog(AtxPowerDialog, rig);
        const confirm = screen.getByRole("button", { name: "Press power" });
        fireEvent.click(confirm);
        fireEvent.click(confirm);
        expect(rig.http.requests).toHaveLength(1);
        expect(confirm).toBeDisabled();
        gate.resolve(status(200));
    });

    it("8: 409 says another client holds the controls and the dialog stays; a 500 says its status", async () => {
        const rig = await openRig();
        pi(rig, "atx", { enabled: true, busy: false, leds: {} });
        rig.session.dialogs.open("atx-power");
        const view = await mountDialog(AtxPowerDialog, rig);
        rig.http.respond = () => status(409);
        fireEvent.click(screen.getByRole("button", { name: "Press power" }));
        expect(await screen.findByText("Another client is using the power controls. Try again in a moment.")).toBeInTheDocument();
        expect(view.closed.count).toBe(0);
        rig.http.respond = () => status(500);
        fireEvent.click(screen.getByRole("button", { name: "Press power" }));
        expect(await screen.findByText("Power action failed (500)")).toBeInTheDocument();
        rig.http.respond = () => Promise.reject(new Error("offline"));
        fireEvent.click(screen.getByRole("button", { name: "Press power" }));
        expect(await screen.findByText("Power action failed: offline")).toBeInTheDocument();
    });

    it("6: with no ATX wiring the press is disabled and the dialog says why", async () => {
        const rig = await openRig();
        await mountDialog(AtxPowerDialog, rig);
        expect(screen.getByRole("button", { name: "Press power" })).toBeDisabled();
        expect(screen.getByText("This PiKVM has no ATX power wiring.")).toBeInTheDocument();
    });
});

describe("paste (9-12)", () => {
    const keymaps = { keymaps: { default: "en-us", available: { "en-us": {}, "en-gb": {}, de: {} } } };

    async function mountPaste() {
        const rig = await openRig();
        pi(rig, "hid_keymaps", keymaps);
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
        const view = await mountDialog(PasteDialog, rig);
        return { rig, view };
    }

    it("9: types the text through the CHOSEN keymap and closes when kvmd has finished", async () => {
        const { rig, view } = await mountPaste();
        const send = screen.getByRole("button", { name: "Type on target" });
        expect(send).toBeDisabled();
        await userEvent.type(screen.getByLabelText("Text to type on the target"), "Hi");
        await userEvent.selectOptions(screen.getByLabelText("Keymap"), "en-gb");
        expect(send).toBeEnabled();
        fireEvent.click(send);
        await waitFor(() => expect(view.closed.count).toBe(1));
        expect(rig.http.requests).toEqual([
            { method: "POST", path: "/api/hid/print?limit=0&delay=0.02&keymap=en-gb", body: "Hi", contentType: "text/plain" },
        ]);
        expect(rig.session.notices.store.getState().text).toBe("Typed 2 characters on the target");
    });

    it("9: Ctrl+Enter sends, and is refused (naming the macro) while one is running", async () => {
        const { rig, view } = await mountPaste();
        const box = screen.getByLabelText("Text to type on the target");
        await userEvent.type(box, "x");
        act(() => void rig.session.gate.beginMacro("Login"));
        expect(screen.getByText(/Login is still running/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Type on target" })).toBeDisabled();
        fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Login is still running"));
        expect(rig.http.requests).toEqual([]);
        expect(view.closed.count).toBe(0);
        act(() => rig.session.gate.endMacro());
        fireEvent.keyDown(box, { key: "Enter", metaKey: true });
        await waitFor(() => expect(view.closed.count).toBe(1));
        expect(rig.http.requests).toHaveLength(1);
    });

    it("10: the keymap list reads kvmd's map; one option is shown but not a choice; none hides the picker", async () => {
        const { rig } = await mountPaste();
        const select = screen.getByLabelText("Keymap");
        expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual(["de", "en-gb", "en-us"]);
        expect(select).toHaveValue("en-us");
        // A repaint from a Pi event keeps the user's pick.
        await userEvent.selectOptions(select, "de");
        pi(rig, "hid_keymaps", keymaps);
        expect(screen.getByLabelText("Keymap")).toHaveValue("de");
        pi(rig, "hid_keymaps", { keymaps: { default: "en-us", available: {} } });
        expect(screen.getByLabelText("Keymap")).toBeDisabled();
    });

    it("10: no keymaps at all hides the control", async () => {
        const rig = await openRig();
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
        await mountDialog(PasteDialog, rig);
        expect(screen.queryByLabelText("Keymap")).toBeNull();
    });

    it("11: counts characters with the duration, and says it is typing while kvmd types", async () => {
        const { rig, view } = await mountPaste();
        const gate = Promise.withResolvers<{ ok: boolean; status: number }>();
        rig.http.respond = () => gate.promise;
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "x".repeat(1500) } });
        expect(screen.getByTestId("paste-count")).toHaveTextContent("1,500 characters \u00b7 about 30s");
        fireEvent.click(screen.getByRole("button", { name: "Type on target" }));
        const progress = await screen.findByTestId("paste-progress");
        expect(progress).toHaveTextContent("Typing 1,500 characters on the target");
        expect(progress).toHaveTextContent("Closing this does not stop it.");
        // Cancel became Close; the dialog stays up until kvmd answers.
        expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Type on target" })).toBeDisabled();
        expect(view.closed.count).toBe(0);
        gate.resolve(status(200));
        await waitFor(() => expect(view.closed.count).toBe(1));
    });

    it("11: closing during the paste does not close whatever opened next", async () => {
        const { rig, view } = await mountPaste();
        const gate = Promise.withResolvers<{ ok: boolean; status: number }>();
        rig.http.respond = () => gate.promise;
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "abc" } });
        fireEvent.click(screen.getByRole("button", { name: "Type on target" }));
        fireEvent.click(await screen.findByRole("button", { name: "Close" }));
        expect(view.closed.count).toBe(1);
        view.unmount();
        gate.resolve(status(200));
        await act(async () => {
            await Promise.resolve();
        });
        expect(view.closed.count).toBe(1);
    });

    it("9: a refused paste (413) keeps the text and the dialog and sends again after a fix", async () => {
        const { rig, view } = await mountPaste();
        rig.http.respond = () => status(413);
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "big" } });
        fireEvent.click(screen.getByRole("button", { name: "Type on target" }));
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("That is too much text for one paste."));
        expect(view.closed.count).toBe(0);
        expect(screen.getByLabelText("Text to type on the target")).toHaveValue("big");
        expect(screen.getByRole("button", { name: "Type on target" })).toBeEnabled();
    });

    it("12: prefills from the host clipboard and a refused clipboard leaves the box empty", async () => {
        const rig = await openRig();
        Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.resolve("from clipboard") }, configurable: true });
        const first = await mountDialog(PasteDialog, rig);
        await waitFor(() => expect(screen.getByLabelText("Text to type on the target")).toHaveValue("from clipboard"));
        first.unmount();
        Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.reject(new Error("denied")) }, configurable: true });
        await mountDialog(PasteDialog, rig);
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByLabelText("Text to type on the target")).toHaveValue("");
    });

    it("a clipboard of curly quotes, CRLF, a zero-width mark and an emoji: the count is what will be typed, what is left out is said, and the clean text is sent", async () => {
        const { rig, view } = await mountPaste();
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "say \u201chi\u201d \u{1f600}\r\nbye\u200b" } });
        expect(screen.getByTestId("paste-count")).toHaveTextContent("13 characters");
        expect(screen.getByTestId("paste-dropped")).toHaveTextContent("1 character the keyboard cannot type (emoji, arrows and the like) will be left out.");
        fireEvent.click(screen.getByRole("button", { name: "Type on target" }));
        await waitFor(() => expect(view.closed.count).toBe(1));
        expect(rig.http.requests[0]?.body).toBe('say "hi" \nbye');
        expect(rig.session.notices.store.getState().text).toBe("Typed 13 characters on the target (1 character the keyboard cannot type was left out)");
    });

    it("text with nothing a keyboard can type is not sendable, and the dialog says so", async () => {
        const { rig } = await mountPaste();
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "\u{1f600}\u{1f680}" } });
        expect(screen.getByRole("button", { name: "Type on target" })).toBeDisabled();
        expect(screen.getByTestId("paste-nothing")).toHaveTextContent("Nothing in this text can be typed on the target.");
        expect(rig.http.requests).toEqual([]);
    });

    it("more than can be typed at once is not sendable, and the dialog says how long it would take", async () => {
        const { rig } = await mountPaste();
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "x".repeat(100_001) } });
        expect(screen.getByRole("button", { name: "Type on target" })).toBeDisabled();
        expect(screen.getByTestId("paste-too-long")).toHaveTextContent("more than the 100,000 characters that can be typed at once (about 33 min)");
        expect(rig.http.requests).toEqual([]);
    });
});
