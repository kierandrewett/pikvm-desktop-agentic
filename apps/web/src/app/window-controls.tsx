/**
 * Minimise, maximise and close for the desktop app's frameless window (Linux and Windows). The
 * page is the titlebar, so the page draws these; macOS keeps its own traffic lights and draws
 * nothing here. Not rendered in a browser or on a phone.
 */

import type { DesktopBridge } from "@pikvm/contracts/desktop";
import { useWindowMaximised } from "../host/desktop";
import { CloseIcon, MaximiseIcon, MinimiseIcon, RestoreIcon } from "../ui/icons";

/** Width the controls take at the right end of the titlebar, for content to keep clear of. */
export const WINDOW_CONTROLS_INSET = 116;

export function WindowControls({ bridge }: { readonly bridge: DesktopBridge }) {
    const maximised = useWindowMaximised();
    return (
        <div className="window-controls" role="group" aria-label="Window controls">
            <button type="button" className="tb-btn" aria-label="Minimise" title="Minimise" onClick={() => bridge.window.minimise()}>
                <MinimiseIcon />
            </button>
            <button
                type="button"
                className="tb-btn"
                aria-label={maximised ? "Restore" : "Maximise"}
                title={maximised ? "Restore" : "Maximise"}
                onClick={() => bridge.window.toggleMaximise()}
            >
                {maximised ? <RestoreIcon /> : <MaximiseIcon />}
            </button>
            <button type="button" className="tb-btn window-close" aria-label="Close" title="Close" onClick={() => bridge.window.close()}>
                <CloseIcon />
            </button>
        </div>
    );
}
