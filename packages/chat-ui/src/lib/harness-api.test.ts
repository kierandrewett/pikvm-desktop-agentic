// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingCreate,
  clearStoredRunId,
  clearStoredToken,
  configureHarnessApi,
  harnessEventStream,
  harnessUrl,
  pendingCreateRequestId,
  readStoredRunId,
  readStoredToken,
  storeRunId,
  storeToken,
} from "./harness-api";

const encoder = new TextEncoder();

const streamResponse = (...chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("selected run storage", () => {
  it("ignores and clears a stored id that is not one", () => {
    // setItem stringifies, so one call with undefined leaves the literal
    // "undefined" behind — truthy, so every later load fetched
    // /api/runs/undefined, took the 404 and left the panel with no composer.
    for (const rubbish of ["undefined", "null", ""]) {
      sessionStorage.setItem("pikvm-harness-selected-run", rubbish);
      expect(readStoredRunId()).toBe("");
      // Removed rather than stepped over: with no runs yet nothing overwrites
      // it, and a key reading "undefined" is a puzzle for whoever looks next.
      expect(sessionStorage.getItem("pikvm-harness-selected-run")).toBeNull();
    }
  });

  it("refuses to write one", () => {
    storeRunId("r7");
    expect(sessionStorage.getItem("pikvm-harness-selected-run")).toBe("r7");
    for (const rubbish of [undefined, null, "", "undefined", "null"]) {
      storeRunId(rubbish as unknown as string);
      expect(sessionStorage.getItem("pikvm-harness-selected-run")).toBeNull();
      storeRunId("r7");
    }
  });

  it("keeps a real id", () => {
    storeRunId("run-2026-08-06");
    expect(readStoredRunId()).toBe("run-2026-08-06");
    clearStoredRunId();
    expect(readStoredRunId()).toBe("");
  });
});

describe("workspace token storage", () => {
  it("keeps connection flow usable when session storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", undefined);

    expect(readStoredToken()).toBe("");
    expect(() => storeToken("workspace-secret")).not.toThrow();
    expect(() => clearStoredToken()).not.toThrow();
  });

  it("keeps connection flow usable when browser storage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });

    expect(readStoredToken()).toBe("");
    expect(() => storeToken("workspace-secret")).not.toThrow();
    expect(() => clearStoredToken()).not.toThrow();
  });
});

describe("durable task identity", () => {
  it("persists the selected run separately from the workspace token", () => {
    storeRunId("run-42");

    expect(readStoredRunId()).toBe("run-42");
    expect(readStoredToken()).toBe("");

    clearStoredRunId();
    expect(readStoredRunId()).toBe("");
  });

  it("reuses an ambiguous create request until the server acknowledges it", () => {
    const first = pendingCreateRequestId("what is on the screen");
    const retry = pendingCreateRequestId("what is on the screen");

    expect(retry).toBe(first);

    clearPendingCreate(first);
    expect(pendingCreateRequestId("what is on the screen")).not.toBe(first);
  });
});

describe("harnessEventStream", () => {
  it("parses authenticated SSE messages split across network chunks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse(
        "event: stream.ready\n",
        'data: {"cursor":12,"status":"running"}\n\nid: 13\n',
        "event: run.event\n",
        'data: {"sequence":13,"kind":"action.attempted"}\n\n',
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: Array<Record<string, unknown>> = [];

    await harnessEventStream(
      "workspace-secret",
      "/api/runs/run-1/stream?after=12",
      {
        onMessage: (message) => messages.push(message),
      },
    );

    expect(messages).toEqual([
      {
        event: "stream.ready",
        data: { cursor: 12, status: "running" },
      },
      {
        event: "run.event",
        id: "13",
        data: { sequence: 13, kind: "action.attempted" },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/stream?after=12",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer workspace-secret");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("workspace-secret");
  });

  it("supports CRLF and multi-line SSE data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse(
          "id: 21\r\nevent: run.state\r\n",
          "data: {\r\ndata: \"status\": \"verifying\"\r\ndata: }\r\n\r\n",
        ),
      ),
    );
    const messages: Array<Record<string, unknown>> = [];

    await harnessEventStream("token", "/stream", {
      onMessage: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      {
        event: "run.state",
        id: "21",
        data: { status: "verifying" },
      },
    ]);
  });

  it("fails safely when the authenticated stream is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "expired workspace token" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      harnessEventStream("expired", "/stream", { onMessage: () => undefined }),
    ).rejects.toMatchObject({
      name: "HarnessApiError",
      status: 401,
      message: "expired workspace token",
    });
  });
});

describe("API base", () => {
  /* The same workspace is hosted twice. Standalone, the harness serves it and
   * its API is on the same origin at /api/*. The PiKVM app serves it from ITS
   * origin, where /api/* is already the kvmd proxy used for HID and streaming,
   * so that host supplies a prefix and the two cannot collide. */
  const withBase = async (base: unknown) => {
    configureHarnessApi({ apiBase: base });
    return harnessUrl;
  };

  afterEach(() => {
    configureHarnessApi({});
  });

  it("leaves paths alone when no base is set", async () => {
    const harnessUrl = await withBase(undefined);
    expect(harnessUrl("/api/runs")).toBe("/api/runs");
  });

  it("prefixes root-relative API paths when the host supplies a base", async () => {
    const harnessUrl = await withBase("/app/harness");
    expect(harnessUrl("/api/runs")).toBe("/app/harness/api/runs");
    expect(harnessUrl("/api/runs/abc/steer")).toBe(
      "/app/harness/api/runs/abc/steer",
    );
  });

  it("does not double the separator on a trailing slash", async () => {
    const harnessUrl = await withBase("/app/harness/");
    expect(harnessUrl("/api/runs")).toBe("/app/harness/api/runs");
  });

  it("leaves an already-absolute URL exactly as the caller wrote it", async () => {
    const harnessUrl = await withBase("/app/harness");
    expect(harnessUrl("http://127.0.0.1:47616/api/runs")).toBe(
      "http://127.0.0.1:47616/api/runs",
    );
  });

  it("ignores a base that is not a usable string", async () => {
    for (const bad of ["", 42, null, {}]) {
      const harnessUrl = await withBase(bad);
      expect(harnessUrl("/api/runs")).toBe("/api/runs");
    }
  });
});
