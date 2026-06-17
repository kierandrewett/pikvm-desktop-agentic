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
            }
        });

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
