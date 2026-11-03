import type { ToolFrame } from "@pikvm/chat-protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PikvmStep, pikvmAction } from "./pikvm-step";

const FRAME: ToolFrame = { id: "abc123def456ghi789", width: 320, height: 180, url: "/api/conversations/c1/frames/abc123def456ghi789" };

function card(over: { name?: string; args?: unknown; frame?: ToolFrame | undefined; state?: "done" | "failed"; output?: string } = {}) {
    const { name = "mcp__pikvm_click", args = { x: 160, y: 90 }, state = "done", output = "Clicked (left) at (160, 90)." } = over;
    return render(
        <ol>
            <PikvmStep
                name={name}
                args={JSON.stringify(args)}
                output={output}
                state={state}
                frame={"frame" in over ? over.frame : FRAME}
            />
        </ol>,
    );
}

const marks = () => [...document.querySelectorAll<HTMLElement>("[data-pikvm-marker]")];
const where = (m: HTMLElement) => [m.style.left, m.style.top];

const originalMatchMedia = window.matchMedia;
afterEach(() => {
    window.matchMedia = originalMatchMedia;
});

describe("what a pointer tool aimed at", () => {
    it("reads the point of a click, a move and a scroll, and both ends of a drag", () => {
        expect(pikvmAction("mcp__pikvm_click", '{"x":10,"y":20}')).toEqual({ kind: "click", count: 1, at: { x: 10, y: 20 } });
        expect(pikvmAction("mcp__pikvm_click", '{"x":10,"y":20,"count":2}')).toEqual({ kind: "click", count: 2, at: { x: 10, y: 20 } });
        expect(pikvmAction("mcp__pikvm_mouse_move", '{"x":1,"y":2}')).toEqual({ kind: "move", at: { x: 1, y: 2 } });
        expect(pikvmAction("mcp__pikvm_scroll", '{"x":1,"y":2,"dy":3}')).toEqual({ kind: "scroll", at: { x: 1, y: 2 } });
        expect(pikvmAction("mcp__pikvm_drag", '{"from":{"x":1,"y":2},"to":{"x":3,"y":4}}')).toEqual({
            kind: "drag",
            from: { x: 1, y: 2 },
            to: { x: 3, y: 4 },
        });
    });

    it("names nothing for a tool that has no point, or arguments that are not one", () => {
        for (const [name, args] of [
            ["mcp__pikvm_screenshot", "{}"],
            ["mcp__pikvm_key", '{"keys":["Enter"]}'],
            ["mcp__pikvm_type_text", '{"text":"x"}'],
            ["mcp__pikvm_click", "{"],
            ["mcp__pikvm_click", "[]"],
            ["mcp__pikvm_click", '{"x":"10","y":20}'],
            ["mcp__pikvm_drag", '{"from":{"x":1,"y":2}}'],
            ["mcp__pikvm_drag", '{"from":null,"to":5}'],
        ] as const)
            expect(pikvmAction(name, args), `${name} ${args}`).toBeUndefined();
    });
});

describe("the picture on a PiKVM card", () => {
    it("shows the screenshot as a thumbnail from the server's route, under the app's mount", () => {
        card({ name: "mcp__pikvm_screenshot", args: {}, output: "Screen 320x180 (frame 1). Mouse: absolute." });
        const thumb = document.querySelector<HTMLElement>("[data-pikvm-thumb]");
        expect(thumb?.tagName).toBe("BUTTON");
        expect(thumb).toHaveAccessibleName("Open the screenshot full size");
        const img = thumb!.querySelector("img")!;
        expect(img.getAttribute("src")).toBe("/app/chat/api/conversations/c1/frames/abc123def456ghi789");
        expect(img).toHaveAttribute("width", "320");
        expect(img).toHaveAttribute("height", "180");
        // The text of the result is still there, and a look has no point to draw.
        expect(screen.getByText("Screen 320x180 (frame 1). Mouse: absolute.")).toBeInTheDocument();
        expect(marks()).toEqual([]);
    });

    it("draws a click on the pixel it hit: the centre of 320x180 is half way across and down", () => {
        card();
        const [mark, ...rest] = marks();
        expect(rest).toEqual([]);
        expect(mark).toHaveAttribute("data-kind", "click");
        expect(where(mark!)).toEqual(["50%", "50%"]);
        expect(document.querySelector("[data-pikvm-thumb]")).toHaveAccessibleName("Open the screenshot full size, with the click marked");
    });

    it("places a mark by the fraction of the frame, whatever the frame's size", () => {
        card({ args: { x: 80, y: 45 } });
        expect(where(marks()[0]!)).toEqual(["25%", "25%"]);
        document.body.innerHTML = "";
        card({ args: { x: 1279, y: 0 }, frame: { ...FRAME, width: 1280, height: 720 } });
        expect(where(marks()[0]!)).toEqual(["99.922%", "0%"]);
    });

    it("keeps a point that lies outside the frame on its edge", () => {
        card({ args: { x: 5000, y: -4 } });
        expect(where(marks()[0]!)).toEqual(["100%", "0%"]);
    });

    it("draws a double click, a move and a scroll in their own way", () => {
        card({ args: { x: 160, y: 90, count: 2 } });
        expect(marks()[0]).toHaveAttribute("data-count", "2");
        document.body.innerHTML = "";
        card({ name: "mcp__pikvm_mouse_move", args: { x: 160, y: 90 } });
        expect(marks()[0]).toHaveAttribute("data-kind", "move");
        document.body.innerHTML = "";
        card({ name: "mcp__pikvm_scroll", args: { x: 160, y: 90, dy: 3 } });
        expect(marks()[0]).toHaveAttribute("data-kind", "scroll");
    });

    it("draws both ends of a drag and the line between them", () => {
        card({ name: "mcp__pikvm_drag", args: { from: { x: 32, y: 18 }, to: { x: 288, y: 162 } } });
        const [from, to] = marks();
        expect(from).toHaveAttribute("data-role", "from");
        expect(to).toHaveAttribute("data-role", "to");
        expect(where(from!)).toEqual(["10%", "10%"]);
        expect(where(to!)).toEqual(["90%", "90%"]);
        // From the press point, as long (a share of the picture's width) and as turned as the drag: (256, 144) frame pixels.
        const line = document.querySelector<HTMLElement>("[data-pikvm-line]")!;
        expect(where(line)).toEqual(["10%", "10%"]);
        expect(parseFloat(line.style.width)).toBeCloseTo((Math.hypot(256, 144) / 320) * 100, 2);
        expect(line.style.transform).toBe(`rotate(${+((Math.atan2(144, 256) * 180) / Math.PI).toFixed(3)}deg)`);
    });

    it("has no picture when the result named none, or the call failed", () => {
        card({ frame: undefined });
        expect(document.querySelector("[data-pikvm-thumb]")).toBeNull();
        expect(screen.getByText("Click at (160, 90)")).toBeInTheDocument();
        document.body.innerHTML = "";
        card({ state: "failed", output: "stale_frame: take a screenshot first" });
        expect(document.querySelector("[data-pikvm-thumb]")).toBeNull();
    });

    it("says so when the server no longer has the picture, and shows no broken image", () => {
        card();
        fireEvent.error(document.querySelector("[data-pikvm-thumb] img")!);
        expect(document.querySelector("[data-pikvm-thumb]")).toBeNull();
        expect(screen.getByText("The screenshot is no longer kept.")).toBeInTheDocument();
        expect(marks()).toEqual([]);
    });
});

describe("the full-size viewer", () => {
    it("opens as a dialog on a desktop, with the same picture and the click on the same pixel", async () => {
        card({ args: { x: 80, y: 45 } });
        await userEvent.click(document.querySelector("[data-pikvm-thumb]")!);
        const dialog = await screen.findByRole("dialog", { name: "Click at (80, 45)" });
        expect(dialog.querySelector("[data-sheet-scroll]")).toBeNull();
        const img = within(dialog).getByRole("img", { name: "Screenshot, with the click marked" });
        expect(img.getAttribute("src")).toBe("/app/chat/api/conversations/c1/frames/abc123def456ghi789");
        const viewerMarks = [...dialog.querySelectorAll<HTMLElement>("[data-pikvm-marker]")];
        expect(viewerMarks.map(where)).toEqual([["25%", "25%"]]);
        // Sized to the frame's aspect ratio and to the screen's height, so the whole screen is in view.
        const frame = dialog.querySelector<HTMLElement>("[data-pikvm-frame]")!;
        expect(frame.style.aspectRatio).toBe("320 / 180");
        expect(frame.style.width).toBe("min(100%, 115.556dvh)");
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens as a bottom sheet on a phone", async () => {
        window.matchMedia = ((query: string) =>
            ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
        card({ name: "mcp__pikvm_screenshot", args: {}, output: "Screen 320x180 (frame 1)." });
        await userEvent.click(document.querySelector("[data-pikvm-thumb]")!);
        const sheet = await screen.findByRole("dialog", { name: "Look at the screen" });
        expect(sheet.querySelector("[data-sheet-scroll]")).not.toBeNull();
        expect(within(sheet).getByRole("img", { name: "Screenshot" })).toBeInTheDocument();
        expect(sheet.querySelector("[data-pikvm-marker]")).toBeNull();
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
