// The reduced picture's two small browser-side parts (K116, K117): the device key, and the poll that names the rung.
//
// The server keeps one rung per device key (src/server/adaptive), so the key has to survive a reload: a phone that
// was on a poor link then starts on the rung it had found, not from the top again.

const KEY_NAME = "pikvm-device-key";
const KEY_LENGTH = 16;
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The page's own key when storage is blocked: it lasts as long as the page, so a private tab still works. */
let pageKey: string | null = null;

function randomKey(): string {
    const bytes = new Uint8Array(KEY_LENGTH);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const byte of bytes) out += KEY_CHARS.charAt(byte % KEY_CHARS.length);
    return out;
}

/** The device key the server tells this browser by: 16 characters of A-Z a-z 0-9, kept in localStorage, made once (K116). */
export function deviceKey(): string {
    try {
        const stored = localStorage.getItem(KEY_NAME);
        if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
        const made = randomKey();
        localStorage.setItem(KEY_NAME, made);
        return made;
    } catch {
        pageKey ??= randomKey();
        return pageKey;
    }
}

export interface RungView {
    /** The rung's name ("full", "half", "quarter"...), for the chip's tooltip. */
    readonly name: string;
}

const POLL_MS = 5000;

/**
 * Names the rung the server has this device on, every 5 s, but only while the reduced picture is on screen and the page is
 * visible (K117). A failed poll says nothing: the chip does not depend on it.
 */
export function createRungPoll(onRung: (rung: RungView | null) => void, key: () => string, fetchImpl: typeof fetch = (...a) => fetch(...a)): {
    start(): void;
    stop(): void;
} {
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    const poll = async (): Promise<void> => {
        if (inFlight || (typeof document !== "undefined" && document.hidden)) return;
        inFlight = true;
        try {
            const res = await fetchImpl(`/app/api/v1/adaptive/status?key=${encodeURIComponent(key())}`, { cache: "no-store" });
            if (!res.ok) return;
            const body = (await res.json()) as { result?: { devices?: Array<{ rungName?: unknown }> } };
            const name = body.result?.devices?.[0]?.rungName;
            if (typeof name === "string") onRung({ name });
        } catch {
            // Nothing to say: the picture is what matters.
        } finally {
            inFlight = false;
        }
    };
    return {
        start() {
            if (timer !== null) return;
            void poll();
            timer = setInterval(() => void poll(), POLL_MS);
        },
        stop() {
            clearInterval(timer ?? undefined);
            timer = null;
            onRung(null);
        },
    };
}
