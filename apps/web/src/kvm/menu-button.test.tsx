// Failure mode K14 in FAILURE_MODES.md.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MenuButton } from "./menu-button";

function mount(run = vi.fn()) {
    render(
        <MenuButton
            label="Send keys"
            icon={<span>k</span>}
            entries={[
                { id: "a", label: "Alpha", run },
                { type: "separator" },
                { id: "b", label: "Beta", run: () => {}, disabled: true },
                { id: "c", label: "Shown", run: () => {}, checked: true },
            ]}
        />,
    );
    return run;
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Send keys" }));

describe("menu button", () => {
    it("K14: opens under its button and runs a pick once, then closes", () => {
        const run = mount();
        expect(screen.queryByRole("group", { name: "Send keys" })).toBeNull();
        open();
        expect(screen.getByRole("button", { name: "Send keys" })).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
        expect(run).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("group", { name: "Send keys" })).toBeNull();
    });

    it("K14: an outside press closes it; a press inside does not", () => {
        mount();
        open();
        fireEvent.pointerDown(screen.getByRole("button", { name: "Alpha" }));
        expect(screen.getByRole("group", { name: "Send keys" })).toBeInTheDocument();
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("group", { name: "Send keys" })).toBeNull();
    });

    it("K14: Escape closes it and hands focus back when it was inside", () => {
        mount();
        open();
        screen.getByRole("button", { name: "Alpha" }).focus();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("group", { name: "Send keys" })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send keys" }));
    });

    it("a disabled entry does not run, and a checked one is announced as pressed", () => {
        const run = mount();
        open();
        expect(screen.getByRole("button", { name: "Beta" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Shown" })).toHaveAttribute("aria-pressed", "true");
        expect(run).not.toHaveBeenCalled();
    });
});
