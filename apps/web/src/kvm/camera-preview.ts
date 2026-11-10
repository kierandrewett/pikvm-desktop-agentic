/**
 * A self-view of the camera, for as long as the camera menu is open and no longer. The hook opens the camera when the
 * component that uses it mounts and stops every track when it unmounts or the choice changes, so a preview is never
 * held while nobody is looking at it (K54). It is its own capture: the session's camera, when the camera is on, is
 * opened separately and is not touched by this one.
 */

import { useEffect, useRef, useState } from "react";
import {
    cameraConstraints,
    cameraKey,
    cameraOpenable,
    classifyCameraError,
    sentFrom,
    type CameraChoice,
    type CameraErrorKind,
    type CameraSent,
} from "./camera";

export type PreviewPhase =
    | "pending"
    | "starting"
    | "live"
    | "denied"
    | "busy"
    | "gone"
    | "none"
    | "stopped"
    | "unsupported"
    | "error";

export interface CameraPreview {
    readonly phase: PreviewPhase;
    readonly stream: MediaStream | null;
    /** What the browser opened: the real size and frame rate, which a camera without the asked mode gives nearest. */
    readonly settings: CameraSent | null;
    /** Open it again (after a refusal was changed in the browser, or another app let go). */
    readonly retry: () => void;
}

/** Whether the camera the choice names can be opened at all, from the list the browser gave. "pending" waits for the list. */
export type CameraPresence = "pending" | "ok" | "gone" | "none";

interface PreviewState {
    readonly phase: PreviewPhase;
    readonly stream: MediaStream | null;
    readonly settings: CameraSent | null;
}

const NOTHING = { stream: null, settings: null } as const;

const phaseOf = (kind: CameraErrorKind): PreviewPhase => (kind === "other" ? "error" : kind);

/**
 * `presence` comes from the device list: with no camera in it, or the chosen one missing, nothing is opened, because
 * asking would raise a permission prompt for a camera that is not there. `onOpened` is called once a preview has been
 * allowed, which is when the browser starts giving camera names.
 */
export function useCameraPreview(choice: CameraChoice, presence: CameraPresence, onOpened: () => void): CameraPreview {
    const [state, setState] = useState<PreviewState>({ phase: "pending", ...NOTHING });
    const [attempt, setAttempt] = useState(0);
    const latest = useRef({ choice, onOpened });
    latest.current = { choice, onOpened };
    const key = cameraKey(choice);

    useEffect(() => {
        if (!cameraOpenable()) {
            setState({ phase: "unsupported", ...NOTHING });
            return;
        }
        if (presence !== "ok") {
            setState({ phase: presence, ...NOTHING });
            return;
        }
        let cancelled = false;
        // A holder, not a `let`: the stream is assigned in a callback, which flow analysis cannot see from the cleanup.
        const held: { stream: MediaStream | null } = { stream: null };
        const asked = latest.current.choice;
        setState({ phase: "starting", ...NOTHING });
        navigator.mediaDevices
            .getUserMedia({ video: cameraConstraints(asked), audio: false })
            .then((granted) => {
                // The menu closed, or the choice changed, while the browser was asking: let go at once.
                if (cancelled) {
                    for (const track of granted.getTracks()) track.stop();
                    return;
                }
                held.stream = granted;
                const track = granted.getVideoTracks()[0];
                setState({ phase: "live", stream: granted, settings: track ? sentFrom(track.getSettings()) : null });
                // Unplugged, or permission withdrawn, while it is showing. The device list says which, a moment later.
                track?.addEventListener("ended", () => {
                    if (!cancelled) setState({ phase: "stopped", ...NOTHING });
                });
                latest.current.onOpened();
            })
            .catch((error: unknown) => {
                if (!cancelled) setState({ phase: phaseOf(classifyCameraError(error, !!asked.deviceId)), ...NOTHING });
            });
        return () => {
            cancelled = true;
            if (held.stream) for (const track of held.stream.getTracks()) track.stop();
        };
    }, [key, presence, attempt]);

    return { ...state, retry: () => setAttempt((n) => n + 1) };
}
