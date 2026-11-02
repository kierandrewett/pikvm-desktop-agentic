import { createManualClock } from "@pikvm/kvm-engine";
import { describe, expect, it, vi } from "vitest";
import { CURSOR_REPORT_MS, CURSOR_REPORT_PATH, createCursorReporter } from "./cursor-report";

describe("cursor report", () => {
    it("sends the latest position once per window, as the workspace, keepalive", async () => {
        const clock = createManualClock();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
        const reporter = createCursorReporter(clock, fetchImpl as unknown as typeof fetch);
        reporter.report(1.4, 2.6);
        reporter.report(10, -20);
        expect(fetchImpl).not.toHaveBeenCalled();

        clock.advance(CURSOR_REPORT_MS);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(CURSOR_REPORT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pikvm-workspace": "1" },
            body: JSON.stringify({ x: 10, y: -20 }),
            keepalive: true,
        });
        clock.advance(CURSOR_REPORT_MS * 3);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("a refused report is not an error, and a disposed reporter sends nothing", async () => {
        const clock = createManualClock();
        const fetchImpl = vi.fn(async () => Promise.reject(new Error("no daemon")));
        const reporter = createCursorReporter(clock, fetchImpl as unknown as typeof fetch);
        reporter.report(1, 1);
        clock.advance(CURSOR_REPORT_MS);
        await Promise.resolve();
        reporter.report(2, 2);
        reporter.dispose();
        clock.advance(CURSOR_REPORT_MS);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
