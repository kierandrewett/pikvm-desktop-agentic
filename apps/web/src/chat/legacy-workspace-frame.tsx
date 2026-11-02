/**
 * TEMPORARY (phase 3 replaces this file with the chat module).
 *
 * Hosts the existing agent workspace in a full-bleed frame, gated on the host reporting
 * that chat is available. It is the only place that knows the workspace is a separate
 * document; its path is a single constant in host/paths.ts.
 *
 * The workspace takes its theme from a message rather than from storage (its markup
 * hardcodes a dark class), so this component keeps that conversation going: it answers the
 * frame's `subscribe` and pushes every theme change, as the console does.
 */

import { useEffect, useRef } from "react";
import { useAppState } from "../api/queries";
import { WORKSPACE_PATH } from "../host/paths";
import { currentTheme, subscribeTheme, type Theme } from "../theme";

const CHANNEL = "pikvm-panel";

function useWorkspaceTheme(frame: React.RefObject<HTMLIFrameElement | null>): void {
    useEffect(() => {
        const send = (theme: Theme) =>
            frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "theme", value: theme }, location.origin);
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
            const data: unknown = event.data;
            if (typeof data !== "object" || data === null) return;
            if ("channel" in data && data.channel === CHANNEL && "type" in data && data.type === "subscribe") {
                send(currentTheme());
            }
        };
        window.addEventListener("message", onMessage);
        const unsubscribe = subscribeTheme(send);
        return () => {
            window.removeEventListener("message", onMessage);
            unsubscribe();
        };
    }, [frame]);
}

function WorkspaceFrame() {
    const frame = useRef<HTMLIFrameElement>(null);
    useWorkspaceTheme(frame);
    return (
        <iframe
            ref={frame}
            className="embed-frame"
            title="Agent workspace"
            src={WORKSPACE_PATH}
            allow="clipboard-read; clipboard-write; microphone"
            onLoad={() => frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "theme", value: currentTheme() }, location.origin)}
        />
    );
}

export function LegacyWorkspaceFrame() {
    const state = useAppState();

    if (state.isPending) return <div className="empty-state" role="status" aria-label="Loading" />;

    if (state.isError) {
        return (
            <div className="empty-state">
                <h1>Cannot reach the app server</h1>
                <p>{state.error.message} Check that the host is running, then try again.</p>
                <button type="button" className="btn btn-primary" onClick={() => void state.refetch()}>
                    Try again
                </button>
            </div>
        );
    }

    if (!state.data.features.chat) {
        return (
            <div className="empty-state">
                <h1>Chat needs the desktop app running</h1>
                <p>
                    The agent runs inside the PiKVM desktop app on your computer, and this host reaches it from there. Open
                    the desktop app, keep it running, then check again.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => void state.refetch()}>
                    Check again
                </button>
            </div>
        );
    }

    return <WorkspaceFrame />;
}
