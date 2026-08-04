/**
 * User-defined macros: named sequences of input the target receives.
 *
 * Stored as plain JSON next to the app's other settings (the XDG config dir),
 * so a macro can be read, diffed, hand-edited and copied between machines
 * without going through the UI. The file is the source of truth; the console
 * reads and writes it through the control server, which keeps web and desktop
 * clients on exactly the same list.
 *
 * A macro is a list of steps because useful ones are rarely a single chord:
 * "open the run box, type a path, press enter" is three. The step kinds are
 * deliberately few — a chord, some text, a pause — since anything more starts
 * to be a scripting language, and the agent already exists for that.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** A key chord: modifiers held while one key is pressed. */
export interface MacroChordStep {
    type: "chord";
    /** Physical modifier codes, e.g. ["ControlLeft", "ShiftLeft"]. */
    mods: string[];
    /** Physical key code, e.g. "KeyS" or "F5". */
    code: string;
}

/** Text typed on the target via the Pi's own keymap. */
export interface MacroTextStep {
    type: "text";
    text: string;
}

/** A pause, for targets that need a moment between steps (menus, dialogs). */
export interface MacroDelayStep {
    type: "delay";
    ms: number;
}

export type MacroStep = MacroChordStep | MacroTextStep | MacroDelayStep;

export interface Macro {
    id: string;
    label: string;
    /** One or two characters drawn on the button — an emoji or initials. */
    icon?: string;
    /** Show it in the titlebar's custom area (otherwise it lives in the menu). */
    pinned?: boolean;
    steps: MacroStep[];
}

const MAX_MACROS = 60;
const MAX_STEPS = 40;
const MAX_DELAY_MS = 10_000;

/** Physical key codes we accept. Anything else is a typo or an injection. */
const CODE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

function cleanStep(raw: unknown): MacroStep | null {
    if (!raw || typeof raw !== "object") return null;
    const step = raw as Record<string, unknown>;
    if (step.type === "chord") {
        const code = typeof step.code === "string" ? step.code : "";
        if (!CODE.test(code)) return null;
        const mods = Array.isArray(step.mods)
            ? step.mods.filter((m): m is string => typeof m === "string" && CODE.test(m)).slice(0, 6)
            : [];
        return { type: "chord", mods, code };
    }
    if (step.type === "text") {
        const text = typeof step.text === "string" ? step.text : "";
        if (!text) return null;
        return { type: "text", text: text.slice(0, 4000) };
    }
    if (step.type === "delay") {
        const ms = Number(step.ms);
        if (!Number.isFinite(ms) || ms <= 0) return null;
        return { type: "delay", ms: Math.min(Math.round(ms), MAX_DELAY_MS) };
    }
    return null;
}

/** Validate and normalise whatever was in the file or sent by a client.
 *  Anything unparseable is dropped rather than rejected wholesale: one bad
 *  macro should not cost the user the other fifty. */
export function cleanMacros(raw: unknown): Macro[] {
    if (!Array.isArray(raw)) return [];
    const out: Macro[] = [];
    const seen = new Set<string>();
    for (const item of raw.slice(0, MAX_MACROS)) {
        if (!item || typeof item !== "object") continue;
        const macro = item as Record<string, unknown>;
        const label = typeof macro.label === "string" ? macro.label.trim().slice(0, 60) : "";
        if (!label) continue;
        const steps = Array.isArray(macro.steps)
            ? macro.steps.slice(0, MAX_STEPS).map(cleanStep).filter((s): s is MacroStep => s !== null)
            : [];
        if (!steps.length) continue;
        let id = typeof macro.id === "string" && macro.id.trim() ? macro.id.trim().slice(0, 64) : label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        while (!id || seen.has(id)) id = `${id || "macro"}-${seen.size + 1}`;
        seen.add(id);
        const icon = typeof macro.icon === "string" ? [...macro.icon.trim()].slice(0, 2).join("") : "";
        out.push({
            id,
            label,
            ...(icon ? { icon } : {}),
            pinned: macro.pinned !== false,
            steps,
        });
    }
    return out;
}

/**
 * The example that ships on first run. Greenshot's region capture is the
 * canonical case: a chord the target's own software listens for, which is
 * fiddly to send by hand because the host intercepts some of those keys.
 */
export const DEFAULT_MACROS: Macro[] = [
    {
        id: "screenshot-region",
        label: "Capture region",
        icon: "⛶",
        pinned: true,
        steps: [{ type: "chord", mods: ["AltLeft", "ControlLeft", "ShiftLeft"], code: "KeyS" }],
    },
];

export class MacroStore {
    private macros: Macro[];

    constructor(private readonly path: string) {
        this.macros = DEFAULT_MACROS;
        if (existsSync(path)) {
            try {
                const parsed = JSON.parse(readFileSync(path, "utf-8"));
                // Accept both a bare array and {macros: [...]} so a hand-edited
                // file in either shape keeps working.
                this.macros = cleanMacros(Array.isArray(parsed) ? parsed : parsed?.macros);
            } catch {
                // A corrupt file must not wipe the user's macros on the next
                // save, so keep the defaults in memory and leave the file be.
                this.macros = DEFAULT_MACROS;
            }
        }
    }

    list(): Macro[] {
        return this.macros.map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s })) }));
    }

    replace(raw: unknown): Macro[] {
        this.macros = cleanMacros(raw);
        try {
            writeFileSync(this.path, JSON.stringify({ macros: this.macros }, null, 2));
        } catch {
            /* best-effort; the in-memory list still serves this session */
        }
        return this.list();
    }
}
