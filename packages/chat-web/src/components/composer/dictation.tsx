/**
 * Dictation (speech to text) for the composer, after the reference "Dictate" control.
 *
 * The Web Speech API writes interim results into the editor as you speak. Where the browser has no recogniser there
 * is no button; this server has no speech routes.
 *
 * States: idle -> starting -> recording -> idle. The waveform is drawn on a canvas from
 * an AnalyserNode at display rate with requestAnimationFrame; React does not re-render per frame.
 */
import { Check, Microphone, X } from "@pikvm/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../l10n/provider";
import { translate } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import { Tooltip } from "../ui/tooltip";
import { ComposerButton, primaryLook } from "./controls";

// The Web Speech API is not in lib.dom for every TypeScript version; keep a minimal local shape.
interface RecognitionResult {
    isFinal: boolean;
    0: { transcript: string };
}
interface RecognitionEvent {
    resultIndex: number;
    results: ArrayLike<RecognitionResult>;
}
interface Recognition {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((e: RecognitionEvent) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type DictationMode = "off" | "browser";
export type DictationState = "idle" | "starting" | "recording";

export function useSpeechConfig(enabled = true): { mode: DictationMode; language: string | undefined } {
    // The chat server has no speech routes here, so dictation is the browser's own recogniser or nothing.
    const mode: DictationMode = enabled && recognitionCtor() ? "browser" : "off";
    return { mode, language: undefined };
}

function micError(e: unknown): string {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (
        name === "NotAllowedError" ||
        name === "SecurityError" ||
        name === "not-allowed" ||
        name === "service-not-allowed"
    )
        return translate("composer-dictation-denied");
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "audio-capture")
        return translate("composer-dictation-no-microphone");
    return translate("composer-dictation-error");
}

export interface DictationHandlers {
    /** The live transcript for this session (final + interim), replacing the previous one. */
    onLive: (transcript: string) => void;
    /** Session ended without keeping text (cancel). */
    onCancel: () => void;
    onError: (message: string) => void;
}

export function useDictation(mode: DictationMode, language: string | undefined, handlers: DictationHandlers) {
    const [state, setState] = useState<DictationState>("idle");
    const analyser = useRef<AnalyserNode | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const audio = useRef<AudioContext | null>(null);
    const recognition = useRef<Recognition | null>(null);
    const cancelled = useRef(false);
    const h = useRef(handlers);
    h.current = handlers;

    const release = useCallback(() => {
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        void audio.current?.close().catch(() => {});
        audio.current = null;
        analyser.current = null;
        recognition.current = null;
    }, []);

    useEffect(
        () => () => {
            cancelled.current = true;
            recognition.current?.abort();
            release();
        },
        [release],
    );

    const start = useCallback(async () => {
        if (mode === "off" || state !== "idle") return;
        cancelled.current = false;
        setState("starting");
        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            });
            stream.current = s;
            const ctx = new AudioContext();
            audio.current = ctx;
            const node = ctx.createAnalyser();
            node.fftSize = 1024;
            node.smoothingTimeConstant = 0.6;
            ctx.createMediaStreamSource(s).connect(node);
            analyser.current = node;

            const Ctor = recognitionCtor();
            if (!Ctor) throw new Error("unsupported");
            const r = new Ctor();
            r.lang = language || navigator.language;
            r.continuous = true;
            r.interimResults = true;
            let finals = "";
            r.onresult = (e) => {
                let interim = "";
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const res = e.results[i];
                    if (!res) continue;
                    if (res.isFinal) finals += res[0].transcript;
                    else interim += res[0].transcript;
                }
                h.current.onLive((finals + interim).trim());
            };
            r.onerror = (e) => {
                if (e.error === "aborted" || e.error === "no-speech") return;
                h.current.onError(micError({ name: e.error }));
            };
            r.onend = () => {
                release();
                setState("idle");
            };
            recognition.current = r;
            r.start();
            setState("recording");
        } catch (e) {
            release();
            setState("idle");
            h.current.onError(micError(e));
        }
    }, [mode, state, language, release]);

    /** Keep what was said. */
    const confirm = useCallback(() => {
        recognition.current?.stop();
    }, []);

    /** Throw it away. */
    const cancel = useCallback(() => {
        cancelled.current = true;
        if (recognition.current) recognition.current.abort();
        else release();
        h.current.onCancel();
        setState("idle");
    }, [release]);

    return { state, start, confirm, cancel, analyser };
}

const BAR = 2;
const GAP = 2;
const SAMPLE_MS = 50;

/**
 * Scrolling level meter: one 2px rounded bar per 50ms of audio, newest on the right, drawn in currentColor.
 * Freezes (keeps the last frame) when `live` is false.
 */
export function Waveform({
    analyser,
    live,
    className,
}: {
    analyser: React.RefObject<AnalyserNode | null>;
    live: boolean;
    className?: string;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const levels = useRef<number[]>([]);

    useEffect(() => {
        const el = canvas.current;
        if (!el || !live) return;
        const ctx = el.getContext("2d");
        if (!ctx) return;
        const data = new Uint8Array(1024);
        let raf = 0;
        let last = 0;
        let peak = 0;
        const frame = (t: number) => {
            raf = requestAnimationFrame(frame);
            const node = analyser.current;
            const dpr = devicePixelRatio || 1;
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
                el.width = Math.round(w * dpr);
                el.height = Math.round(h * dpr);
            }
            if (node) {
                node.getByteTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < node.fftSize && i < data.length; i++) {
                    const v = ((data[i] ?? 128) - 128) / 128;
                    sum += v * v;
                }
                peak = Math.max(peak, Math.sqrt(sum / Math.min(node.fftSize, data.length)));
            }
            if (t - last >= SAMPLE_MS) {
                last = t;
                levels.current.push(Math.min(1, peak * 4));
                peak = 0;
                const max = Math.ceil(w / (BAR + GAP)) + 1;
                if (levels.current.length > max) levels.current.splice(0, levels.current.length - max);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = getComputedStyle(el).color;
            const list = levels.current;
            for (let i = 0; i < list.length; i++) {
                const x = w - (list.length - i) * (BAR + GAP);
                if (x + BAR < 0) continue;
                const bh = Math.max(BAR, (list[i] ?? 0) * (h - 4));
                ctx.beginPath();
                ctx.roundRect(x, (h - bh) / 2, BAR, bh, BAR / 2);
                ctx.fill();
            }
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [analyser, live]);

    useEffect(() => {
        if (!live) return;
        levels.current = [];
    }, [live]);

    return (
        <canvas
            ref={canvas}
            aria-hidden
            className={cn(
                "block h-9 min-w-0 text-text [mask-image:linear-gradient(to_right,transparent,var(--mask-solid)_24px)]",
                className,
            )}
        />
    );
}

/** `phone`: 40px drawn inside the phone composer pill (48px to the touch with the ::after). */
export function DictateButton({
    onClick,
    busy,
    phone = false,
}: {
    onClick: () => void;
    busy: boolean;
    phone?: boolean;
}) {
    const t = useT();
    return (
        <Tooltip label={t("composer-dictate")}>
            <ComposerButton
                aria-label={t("composer-dictate")}
                disabled={busy}
                onClick={onClick}
                phone={phone}
                className="aspect-square px-0"
            >
                <Microphone className="size-5" />
            </ComposerButton>
        </Tooltip>
    );
}

export function DictationControls({
    state,
    onCancel,
    onConfirm,
    phone = false,
}: {
    state: DictationState;
    onCancel: () => void;
    onConfirm: () => void;
    phone?: boolean;
}) {
    const t = useT();
    return (
        <>
            <Tooltip label={t("composer-dictation-cancel")}>
                <ComposerButton
                    aria-label={t("composer-dictation-cancel-label")}
                    onClick={onCancel}
                    phone={phone}
                    className="aspect-square px-0 text-text"
                >
                    <X className="size-5" />
                </ComposerButton>
            </Tooltip>
            <Tooltip label={t("composer-dictation-done")}>
                <button
                    type="button"
                    aria-label={t("composer-dictation-stop-label")}
                    disabled={state === "starting"}
                    onClick={onConfirm}
                    className={cn(
                        "relative flex shrink-0 items-center justify-center rounded-full p-0.5 outline-none transition-opacity duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] disabled:opacity-60",
                        primaryLook,
                        phone ? "size-10 after:absolute after:-inset-1 after:content-['']" : "size-9",
                    )}
                >
                    <Check weight="bold" className="size-5" />
                </button>
            </Tooltip>
        </>
    );
}
