/**
 * A readable device description from a user-agent string, for the session list and default passkey names.
 * Only common browsers and systems are named; anything else says what it can and never guesses.
 */
export type DeviceKind = "desktop" | "mobile" | "tablet" | "other";

export interface DeviceInfo {
    /** "Chrome 141", "Safari", "Bun", or "Unknown browser". */
    browser: string;
    /** "macOS", "iOS", "Windows", ... or "" when unknown. */
    os: string;
    kind: DeviceKind;
    /** "Chrome 141 on Linux". */
    label: string;
}

const major = (ua: string, re: RegExp) => re.exec(ua)?.[1];

function browserOf(ua: string): string {
    const named: [RegExp, string][] = [
        [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
        [/(?:OPR|Opera)\/(\d+)/, "Opera"],
        [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
        [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
        [/(?:CriOS|Chrome)\/(\d+)/, "Chrome"],
        [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, "Safari"],
    ];
    for (const [re, name] of named) {
        const v = major(ua, re);
        if (v) return `${name} ${v}`;
    }
    if (/Safari\//.test(ua)) return "Safari";
    // Programs rather than browsers (API clients, scripts): their own name.
    const tool = /^(Bun|curl|Wget|node|Deno|python-requests|okhttp)\b/i.exec(ua)?.[1];
    return tool ?? "Unknown browser";
}

function systemOf(ua: string): { os: string; kind: DeviceKind } {
    if (/iPad/.test(ua)) return { os: "iPadOS", kind: "tablet" };
    if (/iPhone|iPod/.test(ua)) return { os: "iOS", kind: "mobile" };
    if (/Android/.test(ua)) return { os: "Android", kind: /Mobile/.test(ua) ? "mobile" : "tablet" };
    if (/CrOS/.test(ua)) return { os: "ChromeOS", kind: "desktop" };
    if (/Mac OS X|Macintosh/.test(ua)) return { os: "macOS", kind: "desktop" };
    if (/Windows/.test(ua)) return { os: "Windows", kind: "desktop" };
    if (/Linux|X11/.test(ua)) return { os: "Linux", kind: "desktop" };
    return { os: "", kind: "other" };
}

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
    if (!ua) return { browser: "Unknown browser", os: "", kind: "other", label: "Unknown device" };
    const browser = browserOf(ua);
    const { os, kind } = systemOf(ua);
    return { browser, os, kind, label: os ? `${browser} on ${os}` : browser };
}

/** "iPhone", "Mac", "Windows", ... for naming something made on this device (a passkey). */
export function deviceName(ua: string): string {
    const { os } = describeUserAgent(ua);
    return { iOS: "iPhone", iPadOS: "iPad", macOS: "Mac" }[os] ?? (os || "Device");
}
