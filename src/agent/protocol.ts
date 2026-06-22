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

/**
 * State of a self-verifying goal-pursuit loop: the agent works toward `goal`,
 * then an INDEPENDENT ("blind") verifier judges pass/fail each iteration. Surfaced
 * to the UI so the console can show "iterating (2/6): <whats missing>".
 */
export interface GoalLoopState {
    /** The concrete, checkable objective the loop is pursuing. */
    goal: string;
    /** Optional explicit success criteria the verifier should weigh. */
    criteria?: string;
    /** 1-based current iteration. */
    iteration: number;
    /** Hard cap on iterations (never infinite). */
    cap: number;
    /** Whether the loop is still running. */
    active: boolean;
    /** The last blind verdict (absent before the first verification). */
    lastVerdict?: { achieved: boolean; reason: string; whatsMissing?: string };
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

export interface MeetingSummary {
    id: string;
    startTs: number;
    endTs: number;
    title: string;
    suggestionCount: number;
    hasTranscript: boolean;
}

export interface MeetingRecord {
    id: string;
    startTs: number;
    endTs: number;
    title: string;
    transcript: string;
    suggestions: { ts: number; text: string }[];
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
    /** Live self-verifying goal loop, when one is running (or just finished). */
    goalLoop?: GoalLoopState;
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
        transcribe: boolean;
        ntfyTopic: string;
        ntfyBaseUrl: string;
        hasToken: boolean;
        activeHours: { enabled: boolean; start: string; end: string };
        debug: {
            enabled: boolean;
            onKVM: boolean;
            withinHours: boolean;
            inMeeting: boolean;
            busy: boolean;
            lastStepDiff: number;
            lastBaseDiff: number;
            hasCapture: boolean;
            hasFingerprint: boolean;
            triageModel: string;
        };
        transcript: string;
        /** Live transcription status — why there is/isn't text yet, and which sources are tapped. */
        transcriptStatus: {
            state: "idle" | "no-whisper" | "no-node" | "no-ffmpeg" | "downloading-model" | "no-audio" | "listening" | "transcribing";
            detail: string;
            mic: boolean;
            remote: boolean;
            captureError: string | null;
            segmentCount: number;
            lastSegmentAt: number;
            startedAt: number;
        };
        /** Recent timestamped transcript lines for the UI. */
        transcriptSegments: { ts: number; text: string }[];
        suggestions: { ts: number; text: string }[];
        events: AmbientEvent[];
    };
    /** Named secrets the agent can type but never see. Values are never sent. */
    secrets: { items: { name: string; hint?: string }[]; encrypted: boolean };
    sessions: SessionSummary[];
    settings: {
        humanize: number;
        pauseOnPresence: boolean;
        wpm: number;
        keyboardLayout: "us" | "uk";
        bindHost: string;
        hasToken: boolean;
        desktopUseProxy: boolean;
        atlas: { enabled: boolean; binPath: string; vaultPath: string };
    };
    schedules: { id: string; label: string; when: string }[];
    log: LogEntry[];
}
