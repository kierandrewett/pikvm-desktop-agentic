/**
 * Two things drawn over the screen that are neither the picture nor controls: the toast that
 * says what just happened, and the Pi's own web UI when it is asked for.
 */

import { useEffect, useState } from "react";
import type { KvmSession } from "./session";
import { useStore } from "./use-store";

/** "Macro sent", "Paste failed". Errors interrupt a screen reader; everything else waits its turn. */
export function Toast({ session }: { session: KvmSession }) {
    const { text, error, show } = useStore(session.notices.store);
    return (
        <div
            className={`kvm-toast${show ? " show" : ""}${error ? " is-error" : ""}`}
            // Set before the text on purpose: a live region is read by the politeness it had when its content changed.
            role={error ? "alert" : "status"}
            aria-live={error ? "assertive" : "polite"}
            data-kvm-ui=""
        >
            {text}
        </div>
    );
}

/** How long the framed UI gets before the cover says it is not coming. */
export const FULL_UI_LOAD_MS = 12_000;

/**
 * The Pi's own interface, framed over the picture rather than navigated to, so the connection
 * and the way back stay ours. It is the same origin (it comes back through the host), so nothing
 * here is cross-document. While it is up the engine stops the MJPEG stream: leaving it would hold
 * a second stream open behind the first.
 */
export function FullUiFrame({ onBack }: { readonly onBack: () => void }) {
    const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

    useEffect(() => {
        if (state !== "loading") return;
        const timer = setTimeout(() => setState("failed"), FULL_UI_LOAD_MS);
        return () => clearTimeout(timer);
    }, [state]);

    return (
        <div className="kvm-full-ui" data-kvm-ui="">
            <iframe
                className="kvm-full-ui-frame"
                title="Full PiKVM UI"
                src="/?native=1"
                allow="fullscreen; clipboard-read; clipboard-write"
                onLoad={() => setState("ready")}
            />
            {state === "ready" ? null : (
                <div className="kvm-full-ui-note" role="status" aria-live="polite">
                    <span>{state === "loading" ? "Loading the PiKVM UI" : "The PiKVM UI did not load."}</span>
                    <button type="button" className="kvm-btn" onClick={onBack}>
                        Back to console
                    </button>
                </div>
            )}
            {state === "ready" ? (
                <button type="button" className="kvm-full-ui-back" onClick={onBack}>
                    Back to console
                </button>
            ) : null}
        </div>
    );
}
