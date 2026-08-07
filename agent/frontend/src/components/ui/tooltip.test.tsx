// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

describe("Tooltip", () => {
  it("cannot leave a closed reduced-motion portal in document layout", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Models</TooltipTrigger>
          <TooltipContent>Configure models</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const tooltip = document.querySelector('[data-slot="tooltip-content"]');
    if (!(tooltip instanceof HTMLElement)) {
      throw new Error("Tooltip content did not mount.");
    }
    expect(tooltip).toHaveClass(
      "motion-reduce:data-closed:hidden!",
      "motion-reduce:animate-none!",
    );
    expect(tooltip.parentElement).toHaveClass(
      "motion-reduce:data-closed:hidden!",
    );
  });

  it("is not itself hoverable", () => {
    /* A tooltip is a label, not a target. Without pointer-events: none the
     * popup sits over the control that spawned it and takes the hover itself,
     * so it can be hovered as though interactive and it covers whatever is
     * underneath. Asserted on the positioner because it must cover the popup
     * AND its arrow. */
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Models</TooltipTrigger>
          <TooltipContent>Configure models</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const popup = document.querySelector('[data-slot="tooltip-content"]');
    if (!(popup instanceof HTMLElement)) {
      throw new Error("Tooltip content did not mount.");
    }
    const positioner = popup.parentElement;
    if (!(positioner instanceof HTMLElement)) {
      throw new Error("Tooltip positioner did not mount.");
    }
    expect(positioner).toHaveClass("pointer-events-none");
  });
});
