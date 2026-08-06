/**
 * The wire between the terminal server and the terminal renderer.
 *
 * These four declarations used to exist twice, byte for byte: once in
 * src/terminal-server.ts and once in src/terminal/main.ts. Two separate
 * declarations of the same shape are two sources of truth — TypeScript sees no
 * relationship between them, so adding a message on one side and forgetting the
 * other compiles perfectly and fails at runtime, which is the failure mode a
 * typed protocol exists to prevent.
 *
 * Types only, no runtime code. src/terminal/main.ts is bundled for the browser
 * and terminal-server.ts is Node with a PTY behind it; a shared module that
 * emitted anything would drag one into the other. Everything here is erased at
 * compile time.
 */

export type SessionKind = "shell";

export interface SessionInfo {
    id: string;
    agent: SessionKind;
    title: string;
    exited: boolean;
}

/** Frames the server pushes to clients. */
export type ServerMsg =
    | { t: "sessions"; sessions: SessionInfo[]; cols: number; rows: number; control: string | null }
    | { t: "data"; id: string; data: string }
    | { t: "exit"; id: string; code: number }
    | { t: "control"; owner: string | null }
    | { t: "image"; reqId: number; dataUrl: string | null };

/** Frames a client sends back. */
export type ClientMsg =
    | { t: "create"; agent?: SessionKind }
    | { t: "input"; id: string; data: string }
    | { t: "resize"; cols: number; rows: number }
    | { t: "close"; id: string }
    | { t: "restart"; id: string }
    | { t: "openPath"; path: string }
    | { t: "openLink"; url: string }
    | { t: "readImage"; reqId: number; path: string };
