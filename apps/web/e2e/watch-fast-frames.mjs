// The frames the fast-alerts runs show the fake kvmd: a Windows-like 1920 x 1080 desktop with a taskbar and a clock in the
// bottom-right corner, and the things that happen in that corner, drawn with sharp. The calibration of ZONE_CHANGE_FRACTION
// (src/server/watch/limits.ts) and the end-to-end latency run both use them, so the number is measured on what the run shows.
//
// Two backgrounds, because a pop-up's contrast against what is behind it decides how many grid cells change:
//   dark    a dark blue wallpaper with a dark editor window (the hardest for a dark toast: little contrast)
//   bright  a white document filling the screen with lines of text, caret in the zone (the hardest for the caret: lots of text)

import { createRequire } from "node:module";
import { join } from "node:path";

const W = 1920;
const H = 1080;
const TASKBAR = 48;
const font = `font-family="Open Sans, DejaVu Sans, sans-serif"`;
const mono = `font-family="DejaVu Sans Mono, monospace"`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const text = (x, y, size, fill, s, extra = "") => `<text x="${x}" y="${y}" ${font} font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;

/** The desktop. `clock` is the taskbar's time; `caret` draws a blinking caret in the zone; `pointer` puts the mouse pointer at [x, y]. */
export function desktop({ background, clock = "10:42", date = "11/05/2026", caret = false, pointer = null, tray = false, spinner = 0 }) {
    const parts = [];
    if (background === "dark") {
        parts.push(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14203a"/><stop offset="1" stop-color="#27456b"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>`);
        // A dark editor window across the middle and into the zone, with code in it.
        parts.push(`<rect x="260" y="120" width="1500" height="860" rx="8" fill="#1e1f26" stroke="#3a3c48"/><rect x="260" y="120" width="1500" height="36" rx="8" fill="#2a2c36"/>`);
        parts.push(text(280, 145, 15, "#c8c8d0", "main.ts - Visual Studio Code"));
        for (let i = 0; i < 26; i++) {
            const indent = 300 + (i % 4) * 28;
            parts.push(`<text x="${indent}" y="${196 + i * 29}" ${mono} font-size="17" fill="${i % 3 === 0 ? "#7aa2f7" : i % 3 === 1 ? "#9ece6a" : "#c0caf5"}">${esc(`const value${i} = compute(input, ${i * 7}); // step ${i}`)}</text>`);
        }
    } else {
        parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/><rect width="${W}" height="40" fill="#2b579a"/>`);
        parts.push(text(24, 27, 16, "#ffffff", "Quarterly report.docx - Word"));
        for (let i = 0; i < 31; i++) {
            parts.push(`<text x="140" y="${100 + i * 29}" ${font} font-size="18" fill="#222222">${esc(`Paragraph ${i + 1}: revenue grew in the quarter, driven by the new accounts opened in the north region.`)}</text>`);
            parts.push(`<text x="1250" y="${100 + i * 29}" ${font} font-size="18" fill="#222222">${esc(`Figure ${i + 1}: margins held at ${40 + (i % 9)}%.`)}</text>`);
        }
    }
    // The taskbar, with tray icons and the clock in the very corner.
    parts.push(`<rect y="${H - TASKBAR}" width="${W}" height="${TASKBAR}" fill="#1c1c1c"/>`);
    for (let i = 0; i < 6; i++) parts.push(`<rect x="${880 + i * 52}" y="${H - 38}" width="28" height="28" rx="6" fill="${["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#a855f7", "#e5e7eb"][i]}"/>`);
    parts.push(`<rect x="1660" y="${H - 34}" width="20" height="20" rx="4" fill="#9ca3af"/><rect x="1700" y="${H - 34}" width="20" height="20" rx="4" fill="#9ca3af"/>`);
    parts.push(text(1790, H - 28, 15, "#f0f0f0", clock, `text-anchor="middle"`));
    parts.push(text(1790, H - 10, 14, "#f0f0f0", date, `text-anchor="middle"`));
    // A tray icon that changes colour and gains an unread badge (a chat app's status).
    if (tray) parts.push(`<rect x="1700" y="${H - 34}" width="20" height="20" rx="4" fill="#ef4444"/><circle cx="1722" cy="${H - 36}" r="7" fill="#dc2626"/>`);
    // A 40 px spinner somewhere in the zone (a page loading), at two phases.
    if (spinner) {
        const angle = (spinner * Math.PI) / 2;
        const ax = 1500 + 20 * Math.cos(angle);
        const ay = 760 + 20 * Math.sin(angle);
        parts.push(`<circle cx="1500" cy="760" r="20" fill="none" stroke="#888" stroke-width="4" stroke-opacity="0.35"/><circle cx="${ax}" cy="${ay}" r="5" fill="#ffffff"/>`);
    }
    if (caret) parts.push(`<rect x="1620" y="${background === "dark" ? 718 : 700}" width="2" height="22" fill="#ffffff" stroke="#000" stroke-width="0.5"/>`);
    if (pointer) parts.push(`<path d="M${pointer[0]} ${pointer[1]} l0 19 l5 -5 l4 9 l3 -1.5 l-4 -9 l7 0 z" fill="#fff" stroke="#000"/>`);
    return parts.join("");
}

/**
 * A toast at 100% scale on a 1920 x 1080 screen, drawn like Windows 11's: an app line (11 px), a bold first line (14 px) and
 * further lines (12 px) in Open Sans, which is close to Segoe UI's width (Segoe UI is not available here); `buttons` adds the
 * Accept and Decline of a call. Placed bottom right above the taskbar.
 */
function toast({ card, ink, sub, app, lines, buttons = false, width = 364 }) {
    const height = 44 + lines.length * 24 + (buttons ? 56 : 8);
    const x = W - width - 12;
    const y = H - TASKBAR - 12 - height;
    const out = [`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="${card}" stroke="${sub}" stroke-opacity="0.5"/>`];
    out.push(text(x + 16, y + 26, 11, sub, app));
    lines.forEach((line, i) => out.push(text(x + 16, y + 54 + i * 24, i === 0 ? 14 : 12, i === 0 ? ink : sub, line, i === 0 ? `font-weight="bold"` : "")));
    if (buttons) {
        const top = y + height - 52;
        out.push(`<rect x="${x + 16}" y="${top}" width="150" height="36" rx="6" fill="#16a34a"/>${text(x + 91, top + 23, 13, "#fff", "Accept", `text-anchor="middle"`)}`);
        out.push(`<rect x="${x + 182}" y="${top}" width="166" height="36" rx="6" fill="#dc2626"/>${text(x + 265, top + 23, 13, "#fff", "Decline", `text-anchor="middle"`)}`);
    }
    return out.join("");
}

const LIGHT = { card: "#f3f3f3", ink: "#111111", sub: "#555555" };
const DARK = { card: "#2d2d30", ink: "#ffffff", sub: "#c8c8c8" };

/**
 * The toasts, with the words each one carries (the ground truth the OCR benchmark scores against: `words` are the words a
 * person would read, in order). The `faint` one is the weakest for the zone diff: one line, dark on a near-identical desktop.
 */
export const TOAST_DEFS = {
    email: { ...LIGHT, app: "Outlook", lines: ["Anna Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review"] },
    emailDark: { ...DARK, app: "Outlook", lines: ["Anna Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review"] },
    teams: { ...DARK, app: "Microsoft Teams", lines: ["Ben Carter", "Can you join the standup now? We are waiting"] },
    teamsLight: { ...LIGHT, app: "Microsoft Teams", lines: ["Ben Carter", "Can you join the standup now? We are waiting"] },
    call: { ...DARK, app: "Microsoft Teams", lines: ["Priya Shah is calling you"], buttons: true },
    generic: { ...LIGHT, app: "Windows Update", lines: ["Updates are ready", "Restart now to finish installing the updates."] },
    faint: { card: "#1d2842", ink: "#d8dce8", sub: "#9aa2b8", app: "Slack", lines: ["Ping"] },
};

/** What each toast says, as the words a reader would get. */
export const toastWords = (name) => {
    const def = TOAST_DEFS[name];
    return [def.app, ...def.lines, ...(def.buttons ? ["Accept", "Decline"] : [])].join(" ").split(/\s+/);
};

export const TOASTS = Object.fromEntries(Object.entries(TOAST_DEFS).map(([name, def]) => [name, () => toast(def)]));

export async function drawFastFrames(sharpModules) {
    const modules = sharpModules ?? process.env.SHARP_MODULES ?? join(process.env.HOME, ".cache/pikvm-e2e/sharp/node_modules");
    const sharp = createRequire(`${modules}/`)("sharp");
    const jpeg = (body, quality = 85) =>
        sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`)).jpeg({ quality }).toBuffer();
    const frames = { sharp };
    for (const background of ["dark", "bright"]) {
        const base = { background };
        frames[background] = {
            idle: await jpeg(desktop(base)),
            /** The caret of a text box in the zone, on. */
            caret: await jpeg(desktop({ ...base, caret: true })),
            /** The taskbar clock's minute digit changed. */
            clock: await jpeg(desktop({ ...base, clock: "10:43" })),
            /** Midnight: both clock lines change (the time and the date). */
            clockAndDate: await jpeg(desktop({ ...base, clock: "11:00", date: "11/06/2026" })),
            /** A tray icon changes colour and gains a badge. */
            tray: await jpeg(desktop({ ...base, tray: true })),
            /** A 40 px spinner, two phases a quarter turn apart. */
            spinnerA: await jpeg(desktop({ ...base, spinner: 1 })),
            spinnerB: await jpeg(desktop({ ...base, spinner: 2 })),
            /** The mouse pointer moved from outside the zone to inside it. */
            pointer: await jpeg(desktop({ ...base, pointer: [1700, 760] })),
            pointerBefore: await jpeg(desktop({ ...base, pointer: [900, 500] })),
        };
        for (const [name, draw] of Object.entries(TOASTS)) frames[background][name] = await jpeg(desktop(base) + draw());
    }
    return frames;
}

/**
 * The desktop with one toast on it, as a JPEG like the Pi's (quality 85). `def` is a toast definition (see `TOAST_DEFS`); the toast's
 * words are the caller's, so a run can show a different one every time.
 */
export async function drawToastFrame(sharp, background, def) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${desktop({ background })}${toast(def)}</svg>`);
    return sharp(svg).jpeg({ quality: 85 }).toBuffer();
}

export const FRAME_SIZE = { width: W, height: H };
