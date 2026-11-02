/**
 * TEMPORARY (phase 4 replaces this file with the KVM screen).
 *
 * Hosts the existing console in a full-bleed frame. It is the only place that knows the
 * console is a separate document: nothing else in the app reaches into it or depends on its
 * path, which is a single constant in host/paths.ts.
 */

import { LEGACY_CONSOLE_PATH } from "../host/paths";

export function LegacyConsoleFrame() {
    return (
        <iframe
            className="embed-frame"
            title="PiKVM console"
            src={LEGACY_CONSOLE_PATH}
            // The console needs the clipboard, fullscreen with keyboard lock, and audio.
            allow="fullscreen; clipboard-read; clipboard-write; autoplay; microphone; keyboard-map"
        />
    );
}
