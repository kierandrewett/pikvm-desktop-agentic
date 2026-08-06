import { describe, expect, it } from "vitest";
import { countOf } from "@/lib/plural";

describe("countOf", () => {
  it("keeps a count of one singular", () => {
    /* Counts here are read at a glance to judge whether something is working,
       and one of each is a real state: a run that has just started has one
       event, a scroll can be one step, a tool group can hold one input. Every
       one of them printed the plural — the Diagnostics sheet read "1 events"
       beside "cursor 1". */
    expect(countOf(1, "event")).toBe("1 event");
    expect(countOf(1, "step")).toBe("1 step");
  });

  it("pluralises everything else, zero included", () => {
    expect(countOf(0, "event")).toBe("0 events");
    expect(countOf(2, "input")).toBe("2 inputs");
    expect(countOf(250, "row")).toBe("250 rows");
  });

  it("takes an explicit plural for anything -s would get wrong", () => {
    expect(countOf(2, "entry", "entries")).toBe("2 entries");
    expect(countOf(1, "entry", "entries")).toBe("1 entry");
  });
});
