/**
 * The Chat destination: the agent workspace from @pikvm/chat-ui, rendered in the app (no
 * iframe), talking to the harness through the host's proxy.
 *
 * Three states come before the conversation, in this order:
 *   - the host cannot be reached at all        -> say so, offer a retry;
 *   - the host says chat is not available      -> "Chat needs the desktop app running"
 *     (features.chat is false when the host has no harness proxy, e.g. the web container
 *     before the desktop app has connected to it);
 *   - chat is available but the agent behind the proxy answers 502/503 -> the workspace's
 *     own unavailable state, which keeps retrying by itself.
 *
 * Layout follows the shell's: phone when the pointer is coarse or the window narrow. The
 * shell already sizes the panel to the visual viewport and pads the safe areas, so the
 * workspace is told not to clear them a second time.
 */

import { ChatWorkspace } from "@pikvm/chat-ui";
import { useAppState } from "../api/queries";
import { COMPACT_QUERY, useMediaQuery } from "../app/viewport";
import { HARNESS_API_BASE, HARNESS_MANAGED_TOKEN } from "../host/paths";

export function ChatRoute() {
    const state = useAppState();
    const compact = useMediaQuery(COMPACT_QUERY);

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

    return (
        <div className="chat-surface">
            <ChatWorkspace
                apiBase={HARNESS_API_BASE}
                managedToken={HARNESS_MANAGED_TOKEN}
                compact={compact}
                insets="host"
            />
        </div>
    );
}
