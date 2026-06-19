import { contextBridge, ipcRenderer } from "electron";

function injectCSS(css: string) {
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
}

function inject<T>(fn: (data?: T) => void, data?: T) {
    const s = document.createElement("script");
    s.textContent = `(${fn.toString()})(${JSON.stringify(data)});`;
    document.documentElement.appendChild(s);
    s.remove();
}

contextBridge.exposeInMainWorld("ui", {
    send: (c: string) => ipcRenderer.send(c),
    invoke: <T>(c: string, ...args: any[]): Promise<T> =>
        ipcRenderer.invoke(c, ...args),
    once: (c: string, cb: (...args: any[]) => void) =>
        ipcRenderer.once(c, (_, ...args) => cb(...args)),
    onState: (cb: (s: string) => void) =>
        ipcRenderer.on("window:state", (_, s) => cb(s)),
});

contextBridge.exposeInMainWorld("kvm", {
    async init() {
        console.log("Preload kvm init");

        ipcRenderer.once("kvm-css", (_, css: string) => {
            console.log("Preload injecting CSS");
            injectCSS(css);
        });

        const credentials = await ipcRenderer.invoke(
            "pikvm:autofill-credentials"
        );
        if (credentials) {
            console.log("Preload injecting autofill script");

            inject((credentialsRaw?: string) => {
                console.log("KVM autofill script running");

                const credentials = JSON.parse(credentialsRaw || "{}");

                const usernameInput = document.querySelector(
                    "input#user-input"
                ) as HTMLInputElement | null;
                const passwordInput = document.querySelector(
                    "input#passwd-input"
                ) as HTMLInputElement | null;

                if (usernameInput && passwordInput) {
                    usernameInput.value = credentials.username;
                    passwordInput.value = credentials.password;
                }
            }, JSON.stringify(credentials));
        }

        window.addEventListener("message", (e) => {
            if (e.data === "kvm:navigate-back") {
                console.log("Preload navigating back");

                ipcRenderer.send("navigate-back");
            } else if (e.data.startsWith("kvm:stream-data::")) {
                console.log("Preload received stream data");

                let data = e.data.replace("kvm:stream-data::", "");
                data = JSON.parse(data);

                ipcRenderer.send("kvm-stream-data", data);
            } else if (typeof e.data === "string" && e.data.startsWith("kvm:audio-chunk::")) {
                ipcRenderer.send("kvm:audio-chunk", e.data.slice("kvm:audio-chunk::".length));
            } else if (typeof e.data === "string" && e.data.startsWith("kvm:audio-status::")) {
                try {
                    ipcRenderer.send("kvm:audio-status", JSON.parse(e.data.slice("kvm:audio-status::".length)));
                } catch {}
            }
        });

        // Meeting transcription: mix the user's local mic with the PiKVM playback
        // audio and ship complete ~10s WebM blobs out to main (→ ffmpeg → local
        // whisper). Reports which sources it tapped via "kvm:audio-status" so the UI
        // can say WHY there's no transcript instead of a permanent "Listening…".
        // Toggled by the ambient monitor (or the manual toggle) on meeting start/end.
        const captureAudio = (en?: boolean) => {
            const KEY = "_pikvmStt";
            const g = globalThis as any;
            const postStatus = (s: any) => {
                try {
                    window.postMessage("kvm:audio-status::" + JSON.stringify(s), "*");
                } catch {}
            };
            if (!en) {
                const s = g[KEY];
                if (s) {
                    s.stop = true;
                    try {
                        if (s.rec && s.rec.state !== "inactive") s.rec.stop();
                    } catch {}
                    try {
                        s.micStream && s.micStream.getTracks().forEach((t: any) => t.stop());
                    } catch {}
                    try {
                        s.ctx && s.ctx.close();
                    } catch {}
                    clearTimeout(s.timer);
                    g[KEY] = null;
                }
                postStatus({ mic: false, remote: false, error: null });
                return;
            }
            if (g[KEY]) return;
            const state: any = { stop: false, rec: null, timer: null, micStream: null, ctx: null };
            g[KEY] = state;

            // The remote machine's audio, played back into an <audio>/<video> element.
            const findRemote = (): any => {
                const els = Array.from(document.querySelectorAll("audio,video")) as any[];
                for (const el of els) {
                    try {
                        if (el.srcObject?.getAudioTracks?.().length) return el.srcObject;
                    } catch {}
                }
                for (const el of els) {
                    try {
                        if (typeof el.captureStream === "function") {
                            const s = el.captureStream();
                            if (s.getAudioTracks().length) return s;
                        }
                    } catch {}
                }
                return null;
            };

            // The local mic — usually the same device PiKVM already transmits, so it's
            // typically pre-authorised. Non-fatal if denied: we fall back to remote audio.
            let micError: string | null = null;
            const getMic = async (): Promise<any> => {
                try {
                    if (!navigator.mediaDevices?.getUserMedia) return null;
                    return await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true } as any,
                    });
                } catch (e: any) {
                    micError = e?.name === "NotAllowedError" ? "Microphone permission denied." : null;
                    return null;
                }
            };

            // Mix whatever sources we have into one mono stream for the recorder.
            const buildMixed = (remote: any): { stream: any; mic: boolean; remote: boolean } => {
                const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
                if (!Ctx) return { stream: remote, mic: false, remote: !!remote };
                const ctx = new Ctx();
                state.ctx = ctx;
                const dest = ctx.createMediaStreamDestination();
                let mic = false;
                let rem = false;
                if (state.micStream && state.micStream.getAudioTracks().length) {
                    try {
                        ctx.createMediaStreamSource(state.micStream).connect(dest);
                        mic = true;
                    } catch {}
                }
                if (remote && remote.getAudioTracks().length) {
                    try {
                        ctx.createMediaStreamSource(remote).connect(dest);
                        rem = true;
                    } catch {}
                }
                return { stream: dest.stream, mic, remote: rem };
            };

            const recordOnce = (mixed: { stream: any; mic: boolean; remote: boolean }) => {
                let chunks: any[] = [];
                let rec: any;
                try {
                    rec = new MediaRecorder(mixed.stream, { mimeType: "audio/webm" });
                } catch {
                    try {
                        state.ctx && state.ctx.close();
                        state.ctx = null;
                    } catch {}
                    state.timer = setTimeout(cycle, 5000);
                    return;
                }
                state.rec = rec;
                rec.ondataavailable = (ev: any) => {
                    if (ev.data && ev.data.size) chunks.push(ev.data);
                };
                rec.onstop = () => {
                    try {
                        state.ctx && state.ctx.close();
                        state.ctx = null;
                    } catch {}
                    const blob = new Blob(chunks, { type: "audio/webm" });
                    chunks = [];
                    if (blob.size > 2000) {
                        const fr = new FileReader();
                        fr.onload = () => {
                            const b64 = String(fr.result).split(",")[1];
                            window.postMessage("kvm:audio-chunk::" + b64, "*");
                        };
                        fr.readAsDataURL(blob);
                    }
                    if (!state.stop) state.timer = setTimeout(cycle, 50);
                };
                rec.start();
                setTimeout(() => {
                    try {
                        if (rec.state !== "inactive") rec.stop();
                    } catch {}
                }, 10000);
            };

            const cycle = async () => {
                if (state.stop) return;
                if (!state.micStream && !micError) state.micStream = await getMic();
                const remote = findRemote();
                const mixed =
                    state.micStream || remote
                        ? buildMixed(remote)
                        : { stream: null, mic: false, remote: false };
                if (!mixed.mic && !mixed.remote) {
                    try {
                        state.ctx && state.ctx.close();
                        state.ctx = null;
                    } catch {}
                    postStatus({ mic: false, remote: false, error: micError });
                    state.timer = setTimeout(cycle, 3000);
                    return;
                }
                postStatus({ mic: mixed.mic, remote: mixed.remote, error: null });
                recordOnce(mixed);
            };
            void cycle();
        };
        ipcRenderer.on("kvm:transcribe-start", () => inject(captureAudio, true));
        ipcRenderer.on("kvm:transcribe-stop", () => inject(captureAudio, false));

        // Track the user's own keystrokes/clicks (capture phase, before the page
        // handles them) so the agent can see what's already been typed.
        window.addEventListener(
            "keydown",
            (e) => {
                try {
                    ipcRenderer.send("kvm:user-input", { type: "key", key: (e as KeyboardEvent).key });
                } catch {}
            },
            true
        );
        window.addEventListener(
            "mousedown",
            (e) => {
                try {
                    ipcRenderer.send("kvm:user-input", { type: "mouse", button: (e as MouseEvent).button });
                } catch {}
            },
            true
        );

        inject((_) => {
            (globalThis as any)._getStreamInfoEl = () => {
                let streamInfoEl = document.querySelector(
                    "#pikvm-desktop-stream-info"
                ) as HTMLDivElement | null;

                if (!streamInfoEl) {
                    const windowSizeEl = document.createElement("div");
                    windowSizeEl.classList.add("window-size");

                    const mediaStatusEl = document.createElement("div");
                    mediaStatusEl.classList.add("media-status");
                    mediaStatusEl.style.display = "none";

                    const newEl = document.createElement("div");
                    newEl.id = "pikvm-desktop-stream-info";

                    newEl.appendChild(windowSizeEl);
                    newEl.appendChild(mediaStatusEl);

                    document.body.appendChild(newEl);
                }

                return document.querySelector(
                    "#pikvm-desktop-stream-info"
                ) as HTMLDivElement;
            };
        });

        ipcRenderer.on("window:resize", (_, bounds) => {
            inject((b) => {
                const streamInfoEl = (globalThis as any)._getStreamInfoEl();
                if (!streamInfoEl) return;

                if ((globalThis as any)._streamInfoShowTimer) {
                    clearTimeout((globalThis as any)._streamInfoShowTimer);
                }

                const sizeEl = document.querySelector(
                    "#pikvm-desktop-stream-info .window-size"
                ) as HTMLDivElement;

                const nativeDims = (globalThis as any)._nativeStreamDims;
                sizeEl.textContent = nativeDims
                    ? `${nativeDims.width} x ${nativeDims.height}`
                    : `${b.width} x ${b.height}`;
                streamInfoEl.setAttribute("data-visible", "true");

                (globalThis as any)._streamInfoShowTimer = setTimeout(() => {
                    streamInfoEl.removeAttribute("data-visible");
                }, 3000);
            }, bounds);
        });

        ipcRenderer.on("kvm:media-transmission", (_, data) => {
            inject((d) => {
                document.body.setAttribute(
                    "data-audio-transmitting",
                    d.isTransmittingAudio ? "true" : "false"
                );
                document.body.setAttribute(
                    "data-mic-transmitting",
                    d.isTransmittingMicrophone ? "true" : "false"
                );

                const streamInfoEl = (globalThis as any)._getStreamInfoEl();
                if (!streamInfoEl) return;

                clearTimeout((globalThis as any)._streamInfoShowTimer);

                const mediaStatusEl = document.querySelector(
                    "#pikvm-desktop-stream-info .media-status"
                ) as HTMLDivElement;

                mediaStatusEl.style.display =
                    d.isTransmittingAudio || d.isTransmittingMicrophone
                        ? ""
                        : "none";

                const parts = [];

                if (d.isTransmittingAudio) {
                    parts.push(
                        `<span class="media-pill audio">🔊 Audio</span>`
                    );
                }

                if (d.isTransmittingMicrophone) {
                    parts.push(`<span class="media-pill mic">🎤 Mic</span>`);
                }

                mediaStatusEl.innerHTML = parts.join("");

                streamInfoEl.classList.add("visible");

                (globalThis as any)._streamInfoShowTimer = setTimeout(() => {
                    streamInfoEl.classList.remove("visible");
                }, 3000);
            }, data);
        });

        // When the app window loses focus, swallow all mouse/keyboard in the KVM
        // page so nothing leaks through to the remote machine; restore on focus.
        ipcRenderer.on("kvm:input-enabled", (_, enabled: boolean) => {
            inject((en) => {
                const KEY = "_pikvmInputBlocker";
                const events = [
                    "keydown",
                    "keyup",
                    "keypress",
                    "mousedown",
                    "mouseup",
                    "mousemove",
                    "wheel",
                    "contextmenu",
                ];
                const existing = (globalThis as any)[KEY];
                if (en) {
                    if (existing) {
                        events.forEach((ev) =>
                            window.removeEventListener(ev, existing, true)
                        );
                        (globalThis as any)[KEY] = null;
                    }
                    document.body?.removeAttribute("data-input-blocked");
                } else {
                    if (existing) return; // already blocking
                    const blk = (e: Event) => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        return false;
                    };
                    (globalThis as any)[KEY] = blk;
                    events.forEach((ev) =>
                        window.addEventListener(ev, blk, true)
                    );
                    document.body?.setAttribute("data-input-blocked", "true");
                }
            }, enabled);
        });

        ipcRenderer.on("kvm:release-mouse", () => {
            inject(() => {
                const existingOverlay = document.getElementById(
                    "pikvm-desktop-mouse-release-overlay"
                );
                if (existingOverlay) {
                    existingOverlay.remove();
                }

                const overlay = document.createElement("a");
                overlay.id = "pikvm-desktop-mouse-release-overlay";
                overlay.textContent =
                    "Mouse released. Click to regain control.";

                const kill = (e) => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return false;
                };

                [
                    "keydown",
                    "keyup",
                    "keypress",
                    "mousedown",
                    "mouseup",
                    "mousemove",
                    "wheel",
                    "contextmenu",
                ].forEach((ev) => window.addEventListener(ev, kill, true));

                overlay.addEventListener("click", () => {
                    [
                        "keydown",
                        "keyup",
                        "keypress",
                        "mousedown",
                        "mouseup",
                        "mousemove",
                        "wheel",
                        "contextmenu",
                    ].forEach((ev) =>
                        window.removeEventListener(ev, kill, true)
                    );
                    overlay.remove();
                    document.body.focus();
                });

                document.body.appendChild(overlay);
            });
        });

        inject(() => {
            let done = false;

            const run = () => {
                if (done) return;

                console.log("KVM init script running");

                const btn = document.querySelector(
                    "[data-wm-window-set-full-tab]"
                ) as HTMLButtonElement | null;

                if (btn) {
                    btn.click();
                }

                const backButton = document.querySelector("#navbar .left a");

                if (backButton) {
                    backButton.addEventListener("click", (e) => {
                        e.preventDefault();
                        window.postMessage("kvm:navigate-back", "*");
                    });
                }

                (globalThis as any).ui.onState(async (state: any) => {
                    console.log("KVM received window state:", state);
                    document.body.toggleAttribute(
                        "data-maximized",
                        state.isMaximized
                    );
                    document.body.setAttribute(
                        "data-theme",
                        state.theme || "light"
                    );
                });

                const streamInfo = document.querySelector(
                    "#stream-info"
                ) as HTMLDivElement | null;

                if (streamInfo) {
                    let lastDims = "";

                    const extractDims = (text: string) => {
                        const m = text.match(/(\d+)\s*x\s*(\d+)/);
                        return m ? `${m[1]}x${m[2]}` : "";
                    };

                    const observer = new MutationObserver(() => {
                        const firstText = streamInfo.childNodes[0]?.nodeValue;

                        const isTransmittingAudio = firstText
                            ?.toLowerCase()
                            .includes("audio")
                            ? true
                            : false;

                        const isTransmittingMicrophone = firstText
                            ?.toLowerCase()
                            .includes("mic")
                            ? true
                            : false;

                        const dims = extractDims(firstText || "");
                        if (!dims || !dims.includes("x")) return;

                        const width = parseInt(dims!.split("x")[0]!, 10);
                        const height = parseInt(dims!.split("x")[1]!, 10);

                        let capStyle = document.getElementById(
                            "pikvm-desktop-canvas-cap"
                        ) as HTMLStyleElement | null;
                        if (!capStyle) {
                            capStyle = document.createElement("style");
                            capStyle.id = "pikvm-desktop-canvas-cap";
                            document.head.appendChild(capStyle);
                        }
                        capStyle.textContent = `
                            #stream-box {
                                display: flex !important;
                                align-items: center !important;
                                justify-content: center !important;
                                overflow: hidden !important;
                                pointer-events: none !important;
                            }
                            #stream-image,
                            #stream-video,
                            #stream-canvas {
                                max-width: ${width}px !important;
                                max-height: ${height}px !important;
                                pointer-events: auto !important;
                            }
                        `;

                        (globalThis as any)._nativeStreamDims = {
                            width,
                            height,
                        };

                        const streamInfoEl = (
                            globalThis as any
                        )._getStreamInfoEl?.();
                        if (streamInfoEl) {
                            const sizeEl = document.querySelector(
                                "#pikvm-desktop-stream-info .window-size"
                            ) as HTMLDivElement;
                            if (sizeEl) {
                                sizeEl.textContent = `${width} x ${height}`;
                            }
                        }

                        window.postMessage(
                            `kvm:stream-data::${JSON.stringify({
                                width,
                                height,
                                isTransmittingAudio,
                                isTransmittingMicrophone,
                            })}`,
                            "*"
                        );
                    });

                    observer.observe(streamInfo, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                }

                const transmittingDots = document.createElement("div");
                transmittingDots.id = "pikvm-desktop-transmitting-dots";

                const audioDot = document.createElement("div");
                audioDot.classList.add("dot", "audio");
                transmittingDots.appendChild(audioDot);

                const micDot = document.createElement("div");
                micDot.classList.add("dot", "mic");
                transmittingDots.appendChild(micDot);

                document.body.appendChild(transmittingDots);

                if (btn || backButton) {
                    done = true;
                }
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", run);
            } else {
                run();
            }

            const obs = new MutationObserver(() => {
                run();
                obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });
    },
});
