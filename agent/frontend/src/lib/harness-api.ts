const TOKEN_KEY = "pikvm-harness-token";
const SELECTED_RUN_KEY = "pikvm-harness-selected-run";
const PENDING_CREATE_KEY = "pikvm-harness-pending-create";

export class HarnessApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HarnessApiError";
    this.status = status;
  }
}

const browserSessionStorage = (): Storage | undefined => {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
};

export const readStoredToken = () => {
  try {
    return browserSessionStorage()?.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};

export const storeToken = (token: string) => {
  try {
    browserSessionStorage()?.setItem(TOKEN_KEY, token);
  } catch {
    // Storage is a convenience only; the active React state still owns access.
  }
};

export const clearStoredToken = () => {
  try {
    browserSessionStorage()?.removeItem(TOKEN_KEY);
  } catch {
    // A blocked storage backend must not prevent an explicit disconnect.
  }
};

/* A run id that is not a run id poisons the session.
 *
 * setItem stringifies whatever it is given, so one call with undefined writes
 * the literal "undefined" — and that is truthy, so every later load treats it
 * as a selected run, fetches /api/runs/undefined, takes the 404 and comes up on
 * "Task unavailable" with no composer at all. Nothing clears it, and
 * sessionStorage outlives a reload, so the panel stays unusable for the life of
 * the window. Observed exactly that: pikvm-harness-selected-run = "undefined"
 * and GET /api/runs/undefined on every load.
 *
 * Guarded on both sides on purpose. The write stops it happening again whoever
 * calls it — selectRun takes its id from the assistant-ui thread adapter, which
 * is outside this codebase — and the read heals a session already carrying one.
 */
const usableRunId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "undefined" &&
  value !== "null";

export const readStoredRunId = () => {
  try {
    const store = browserSessionStorage();
    const stored = store?.getItem(SELECTED_RUN_KEY);
    if (usableRunId(stored)) return stored;
    // Take it out rather than stepping over it every load: with no runs yet
    // nothing overwrites it, and a key reading "undefined" is a puzzle for
    // whoever opens devtools next.
    if (stored !== null && stored !== undefined) store?.removeItem(SELECTED_RUN_KEY);
    return "";
  } catch {
    return "";
  }
};

export const storeRunId = (runId: string) => {
  try {
    const store = browserSessionStorage();
    if (!store) return;
    // Clearing rather than writing rubbish: the next read then falls through to
    // the newest run, which is where a session with no selection should land.
    if (!usableRunId(runId)) {
      store.removeItem(SELECTED_RUN_KEY);
      return;
    }
    store.setItem(SELECTED_RUN_KEY, runId);
  } catch {
    // Session selection is best-effort; active React state still owns it.
  }
};

export const clearStoredRunId = () => {
  try {
    browserSessionStorage()?.removeItem(SELECTED_RUN_KEY);
  } catch {
    // A blocked storage backend must not prevent explicit navigation.
  }
};

type PendingCreate = {
  task: string;
  requestId: string;
};

const newRequestId = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a browser-compatible opaque identifier.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const pendingCreateRequestId = (task: string) => {
  const storage = browserSessionStorage();
  try {
    const stored = storage?.getItem(PENDING_CREATE_KEY);
    if (stored) {
      const pending = JSON.parse(stored) as Partial<PendingCreate>;
      if (
        pending.task === task &&
        typeof pending.requestId === "string" &&
        pending.requestId
      ) {
        return pending.requestId;
      }
    }
  } catch {
    // Replace malformed or unavailable state with a fresh request identity.
  }
  const requestId = newRequestId();
  try {
    storage?.setItem(
      PENDING_CREATE_KEY,
      JSON.stringify({ task, requestId } satisfies PendingCreate),
    );
  } catch {
    // Server-side idempotency still applies for this in-memory request.
  }
  return requestId;
};

export const clearPendingCreate = (requestId: string) => {
  const storage = browserSessionStorage();
  try {
    const stored = storage?.getItem(PENDING_CREATE_KEY);
    if (!stored) return;
    const pending = JSON.parse(stored) as Partial<PendingCreate>;
    if (pending.requestId === requestId) {
      storage?.removeItem(PENDING_CREATE_KEY);
    }
  } catch {
    // A malformed best-effort replay marker can be ignored after success.
  }
};

const responseMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
  } catch {
    // The generic status below remains safe and useful.
  }
  return `${response.status} ${response.statusText}`.trim();
};

/**
 * Where the harness API lives, relative to wherever this app was served from.
 *
 * Empty in the standalone case: the harness serves this app itself, so its API
 * is on the same origin at /api/*. The desktop serves it from ITS origin, and
 * there /api/* is already the kvmd proxy the console uses for HID and streaming
 * — the two would collide, so the desktop supplies a prefix instead.
 *
 * Read from a global the host page sets before this bundle runs, rather than
 * from an env define, because the same built asset is served by both hosts. One
 * lookup at module load, so none of the ~96 call sites has to know it exists.
 */
function readApiBase(): string {
  const raw = (globalThis as { __PIKVM_HARNESS_API_BASE__?: unknown })
    .__PIKVM_HARNESS_API_BASE__;
  if (typeof raw !== "string" || raw === "") return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

const API_BASE = readApiBase();

/**
 * Resolve an API path against that base.
 *
 * Only root-relative paths are rebased. Anything already absolute is a
 * deliberate choice by the caller and is left exactly as it is.
 */
export function harnessUrl(path: string): string {
  return API_BASE && path.startsWith("/") ? `${API_BASE}${path}` : path;
}

/**
 * Marks a request as coming from this bundle.
 *
 * Its only job is to be un-settable by a cross-origin request without a
 * preflight. When the desktop serves this app, its proxy attaches the operator
 * capability server-side, and that capability can start a run or answer an
 * approval — so a page elsewhere in the browser must not be able to reach it by
 * POSTing at 127.0.0.1. Sent unconditionally: standalone is same-origin, where
 * it costs nothing and no preflight happens.
 */
export function workspaceHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("X-PiKVM-Workspace", "1");
  return headers;
}

export async function harnessJson<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = workspaceHeaders(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(harnessUrl(path), {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new HarnessApiError(response.status, await responseMessage(response));
  }
  return (await response.json()) as T;
}

export async function harnessBlob(
  token: string,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const blobHeaders = workspaceHeaders();
  blobHeaders.set("Authorization", `Bearer ${token}`);
  const response = await fetch(harnessUrl(path), {
    headers: blobHeaders,
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new HarnessApiError(response.status, await responseMessage(response));
  }
  return response.blob();
}

export type HarnessStreamMessage = {
  event: string;
  id?: string;
  data: unknown;
};

type HarnessEventStreamOptions = {
  signal?: AbortSignal;
  onMessage: (message: HarnessStreamMessage) => void;
};

const decodeSseMessage = (block: string): HarnessStreamMessage | null => {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  const body = data.join("\n");
  let payload: unknown = body;
  try {
    payload = JSON.parse(body);
  } catch {
    // A non-JSON diagnostic remains visible to the caller without breaking
    // the authenticated stream.
  }
  return { event, ...(id == null ? {} : { id }), data: payload };
};

export async function harnessEventStream(
  token: string,
  path: string,
  options: HarnessEventStreamOptions,
): Promise<void> {
  const headers = workspaceHeaders();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "text/event-stream");
  const response = await fetch(harnessUrl(path), {
    headers,
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new HarnessApiError(response.status, await responseMessage(response));
  }
  if (!response.body) {
    throw new HarnessApiError(502, "Live update stream has no response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (block: string) => {
    const message = decodeSseMessage(block);
    if (message) options.onMessage(message);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
}
