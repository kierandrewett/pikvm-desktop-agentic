/**
 * Shared wire types for the sidebar chat, used by both the server bridge and
 * the React renderer. Custom AI SDK data parts carry the computer-use specifics
 * (screenshots, status banners, authorization prompts, the operation log).
 */

import type { UIMessage } from "ai";
import type { AuthRequest, LogEntry, ReviewPolicy } from "../reviewer";

export interface ScreenshotData {
    toolCallId: string;
    /** data: URL of the JPEG frame. */
    src: string;
    width: number;
    height: number;
}

export interface StatusData {
    kind: "presence" | "auth" | "info" | "loop";
    paused?: boolean;
    text: string;
}

export interface AuthData {
    request: AuthRequest;
}

export interface ThinkingData {
    id: string;
    text: string;
    done?: boolean;
}

export interface MarkerData {
    /** The screenshot (toolCallId) this action targets. */
    screenshotId: string;
    x: number;
    y: number;
    kind: "click" | "double_click" | "move";
}

export type PiKvmDataParts = {
    screenshot: ScreenshotData;
    status: StatusData;
    auth: AuthData;
    log: LogEntry;
    thinking: ThinkingData;
    marker: MarkerData;
    steer: { text: string };
};

export type PiKvmUIMessage = UIMessage<never, PiKvmDataParts>;

export interface AmbientEvent {
    id: string;
    ts: number;
    kind: "notification" | "email" | "message" | "meeting-start" | "meeting-end" | "app-change" | "content-change" | "info";
    title: string;
    detail?: string;
    important: boolean;
    notified: boolean;
    /** Tiny data: URL thumbnail of the frame that triggered it. */
    thumb?: string;
}

export interface SessionSummary {
    id: string;
    title: string;
    updatedAt: number;
    messageCount: number;
}

export interface ServerState {
    policy: ReviewPolicy;
    presence: { paused: boolean; reason?: string };
    goal?: string;
    loggedIn: boolean;
    streaming: boolean;
    acting: boolean;
    pausedForUser: boolean;
    model: string;
    models: string[];
    context: { tokens: number; max: number };
    sessionId: string;
    /** Bumped when an autonomous/scheduled run updates the transcript. */
    uiVersion: number;
    /** Auth request ids the server is currently blocked on (awaiting a decision). */
    pendingAuthIds: string[];
    /** Ambient background monitor: config + state + recent events. */
    ambient: {
        enabled: boolean;
        inMeeting: boolean;
        notify: boolean;
        meetingAssist: boolean;
        ntfyTopic: string;
        hasToken: boolean;
        events: AmbientEvent[];
    };
    /** Named secrets the agent can type but never see. Values are never sent. */
    secrets: { items: { name: string; hint?: string }[]; encrypted: boolean };
    sessions: SessionSummary[];
    settings: { humanize: number; pauseOnPresence: boolean; wpm: number };
    schedules: { id: string; label: string; when: string }[];
    log: LogEntry[];
}
