/**
 * The picture: the markup the video and pointer machines act on, plus the overlays that say what
 * the signal is doing. React renders it once and never touches it again: the machines toggle
 * classes and styles on these same elements (`has-frame`, `frozen`, `offline`, `hold-armed`,
 * transforms), so the class names here are constants and nothing here is conditional on state.
 */

import { createStore, STATUS, type ReadableStore } from "@pikvm/kvm-engine";
import { useEffect, useRef, useState } from "react";
import type { FieldFocus } from "./field-focus";
import { createPictureController, type PictureController, type PicturePrefs, type PictureState } from "./picture-controller";
import type { KvmSession } from "./session";
import { useStore } from "./use-store";

export interface PictureProps {
    readonly session: KvmSession;
    readonly focus: FieldFocus;
    readonly desktop: boolean;
    readonly prefs: PicturePrefs;
    readonly onController: (controller: PictureController | null) => void;
}

const BLANK: PictureState = {
    signal: "connecting",
    mode: "detecting",
    webrtc: false,
    scale: 1,
    audio: { available: false, audioOn: true, micOn: false, micLabel: "Off", micWarn: false },
    res: { text: "", av: "", show: false },
    fullUi: false,
    hasFrame: false,
    width: 0,
    height: 0,
};
const BLANK_STORE: ReadableStore<PictureState> = createStore(BLANK);

/** The controller's state, or a blank one before the picture has mounted. */
export function usePictureState(controller: PictureController | null): PictureState {
    return useStore(controller?.store ?? BLANK_STORE);
}

export function Picture({ session, focus, desktop, prefs, onController }: PictureProps) {
    const pane = useRef<HTMLDivElement>(null);
    const img = useRef<HTMLImageElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const freeze = useRef<HTMLCanvasElement>(null);
    const cursor = useRef<HTMLDivElement>(null);
    const lens = useRef<HTMLCanvasElement>(null);
    // Made after the first paint (it needs the elements), so the overlay draws from the blank
    // state once and then follows the real one.
    const [controller, setController] = useState<PictureController | null>(null);
    const latest = useRef(prefs);
    latest.current = prefs;
    const shown = usePictureState(controller);

    useEffect(() => {
        const els = {
            pane: pane.current,
            img: img.current,
            video: video.current,
            freeze: freeze.current,
            cursor: cursor.current,
            lens: lens.current,
        };
        if (!els.pane || !els.img || !els.video || !els.freeze || !els.cursor || !els.lens) return;
        const created = createPictureController({
            session,
            elements: { pane: els.pane, img: els.img, video: els.video, freeze: els.freeze, cursor: els.cursor, lens: els.lens },
            focus,
            desktop,
            prefs: latest.current,
        });
        setController(created);
        onController(created);
        return () => {
            setController(null);
            onController(null);
            created.dispose();
        };
    }, [session, focus, desktop, onController]);

    useEffect(() => {
        controller?.setPrefs(prefs);
    }, [controller, prefs]);

    const label = STATUS[shown.signal].label;
    return (
        <div ref={pane} className="kvm-pane" data-testid="kvm-pane" data-stream-state="connecting">
            <img ref={img} className="kvm-img" alt="Remote target screen" draggable={false} />
            {/* Occupies the exact box of the <img>; shown when WebRTC is playing, hidden when it is not. Muted until audio is allowed. */}
            <video ref={video} className="kvm-video hidden" autoPlay playsInline muted />
            {/* The last good frame, held while the stream is re-established, so a reconnect does not look like the target going away. */}
            <canvas ref={freeze} className="kvm-freeze" aria-hidden="true" />
            <div ref={cursor} className="kvm-cursor" aria-hidden="true" />
            <canvas ref={lens} className="kvm-lens" aria-hidden="true" />

            <div className="kvm-overlay" role="status" aria-live="polite" data-kvm-ui="">
                <div className="kvm-stream-state">
                    <div className="kvm-spinner" aria-hidden="true" hidden={shown.signal === "nosignal"} />
                    <span>{label}</span>
                </div>
            </div>

            <div className={`kvm-res-toast${shown.res.show ? " show" : ""}`} role="status" aria-live="polite" data-kvm-ui="">
                <span>{shown.res.text}</span>
                {shown.res.av ? <span className="kvm-res-av">{shown.res.av}</span> : null}
            </div>
        </div>
    );
}
