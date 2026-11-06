/**
 * Failure modes of the live-screen window over Chat and Settings:
 *  P1. It shows on the KVM tab, where the picture is already the whole screen.
 *  P2. It shows before there is a picture to float (no PiKVM set up yet): an empty box over Chat.
 *  P3. A throw ends with a click that also opens the KVM.
 *  P4. A tap does not open the KVM.
 *  P5. It can be moved only with a pointer: a keyboard cannot.
 */

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, installViewport, renderApp } from "../test/harness";

beforeAll(async () => {
    await import("@pikvm/chat-web");
});

beforeEach(() => {
    installFakeServer(defaultServer());
    installViewport();
    // The content area: jsdom lays nothing out.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const pip = () => document.querySelector<HTMLElement>(".pip");
const open = () => screen.getByRole("button", { name: /Open the KVM screen/ });

describe("the live screen window", () => {
    it("P1: is not on the KVM tab", async () => {
        renderApp("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        expect(pip()).toBeNull();
    });

    it("P2: is there on Chat and Settings but not shown until the KVM has a picture", async () => {
        renderApp("/settings");
        await screen.findByRole("tab", { name: "Settings" });
        expect(pip()).not.toBeNull();
        expect(pip()).not.toHaveAttribute("data-live");
    });

    it("P4: a tap opens the KVM", async () => {
        renderApp("/settings");
        await screen.findByRole("tab", { name: "Settings" });
        fireEvent.pointerDown(open(), { button: 0, pointerId: 1, clientX: 500, clientY: 100 });
        fireEvent.pointerUp(open(), { pointerId: 1, clientX: 501, clientY: 101 });
        fireEvent.click(open());
        await waitFor(() => expect(screen.getByRole("tab", { name: "KVM" })).toHaveAttribute("aria-selected", "true"));
    });

    it("P3: dragging it moves it, and the click that ends the drag does not open the KVM", async () => {
        renderApp("/settings");
        await screen.findByRole("tab", { name: "Settings" });
        const before = pip()!.style.transform;
        fireEvent.pointerDown(open(), { button: 0, pointerId: 1, clientX: 900, clientY: 40, timeStamp: 0 });
        fireEvent.pointerMove(open(), { pointerId: 1, clientX: 600, clientY: 300, timeStamp: 400 });
        fireEvent.pointerMove(open(), { pointerId: 1, clientX: 600, clientY: 300, timeStamp: 800 });
        fireEvent.pointerUp(open(), { pointerId: 1, clientX: 600, clientY: 300, timeStamp: 900 });
        fireEvent.click(open());
        expect(pip()!.style.transform).not.toBe(before);
        expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    });

    it("P5: Shift and the arrow keys move it (up, from its first place at the bottom of Settings)", async () => {
        renderApp("/settings");
        await screen.findByRole("tab", { name: "Settings" });
        const before = pip()!.style.transform;
        act(() => {
            fireEvent.keyDown(open(), { key: "ArrowUp", shiftKey: true });
        });
        expect(pip()!.style.transform).not.toBe(before);
        fireEvent.keyDown(open(), { key: "ArrowUp" });
        const moved = pip()!.style.transform;
        fireEvent.keyDown(open(), { key: "ArrowUp" });
        expect(pip()!.style.transform).toBe(moved);
    });

    it("can be hidden for the visit", async () => {
        renderApp("/settings");
        await screen.findByRole("tab", { name: "Settings" });
        fireEvent.click(screen.getByRole("button", { name: "Hide the live screen" }));
        expect(pip()).toBeNull();
    });
});
