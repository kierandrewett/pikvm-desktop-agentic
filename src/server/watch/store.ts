import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ALERT_ZONE, type CheckEntry, type WatchSettings, type WatchZone } from "@pikvm/contracts/watch";
import { DEFAULT_SUMMARY_MODEL, DEFAULT_VISION_MODEL, MAX_RULE_CHARS } from "./limits";

/**
 * What a user's watch keeps on disk, under `users/<id>/watch/`:
 *
 *   settings.json               on or off, the plain-English rule, the image model, fast alerts and their zone
 *   checks.jsonl                one line per check, so the person can see why a notification came or did not
 *   checks.jsonl.1              the previous log, kept when checks.jsonl passes `LOG_ROTATE_BYTES`
 *   push-subscriptions.json     the devices that asked for notifications (push.ts)
 *
 * Files are 0600 in a 0700 directory: the log holds what was on the screen.
 */

export const DEFAULT_SETTINGS: WatchSettings = {
    enabled: false,
    rule: "",
    visionModel: DEFAULT_VISION_MODEL,
    fastAlerts: false,
    fastSummary: false,
    summaryModel: DEFAULT_SUMMARY_MODEL,
    alertZone: DEFAULT_ALERT_ZONE,
};

/** A zone smaller than this (of the frame, either way) cannot hold a pop-up, and would be a few cells of noise. */
const MIN_ZONE_SIDE = 0.05;

/** The rectangle in `value` if it is a usable zone (fractions of the frame, inside it, not tiny); undefined otherwise. */
export function parseZone(value: unknown): WatchZone | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const side = (key: string): number | undefined => {
        const number = Reflect.get(value, key);
        return typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
    };
    const x0 = side("x0");
    const y0 = side("y0");
    const x1 = side("x1");
    const y1 = side("y1");
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
    if (x1 - x0 < MIN_ZONE_SIDE || y1 - y0 < MIN_ZONE_SIDE) return undefined;
    return { x0, y0, x1, y1 };
}

const LOG_ROTATE_BYTES = 512 * 1024;
/** `provider/model`, optionally `~provider/model` or with a `:variant` suffix, as OpenRouter lists them. */
const MODEL_ID = /^(?=.{3,120}$)[A-Za-z0-9~][\w.~-]*\/[\w.~+-]+(?::[\w.-]+)?$/;

export class SettingsError extends Error {}

export interface WatchStore {
    userIds(): string[];
    read(userId: string): WatchSettings;
    /** Validate and write; returns what is stored. Throws `SettingsError` with a message fit to show. */
    write(userId: string, patch: Partial<WatchSettings>): WatchSettings;
    append(userId: string, entry: CheckEntry): void;
    /** Newest first. */
    log(userId: string, limit: number): CheckEntry[];
    /**
     * Checks in which a model was called at or after `sinceMs`. `kind: "alert"` counts the fast alerts and nothing else;
     * without it everything but them is counted, so each path has a budget of its own.
     */
    askedSince(userId: string, sinceMs: number, kind?: "alert"): number;
    /** The file the push module keeps this user's subscriptions in. */
    subscriptionsFile(userId: string): string;
}

function endsMidLine(file: string): boolean {
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    if (size === 0) return false;
    const fd = openSync(file, "r");
    try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        return last[0] !== 0x0a;
    } finally {
        closeSync(fd);
    }
}

function privateDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function createWatchStore(options: { userDir(userId: string): string; usersRoot(): string }): WatchStore {
    const dir = (userId: string) => join(options.userDir(userId), "watch");
    const settingsFile = (userId: string) => join(dir(userId), "settings.json");
    const logFile = (userId: string) => join(dir(userId), "checks.jsonl");

    function readLines(file: string): CheckEntry[] {
        if (!existsSync(file)) return [];
        const out: CheckEntry[] = [];
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (line.trim() === "") continue;
            try {
                const entry: unknown = JSON.parse(line);
                if (entry !== null && typeof entry === "object" && typeof Reflect.get(entry, "t") === "number") {
                    out.push(entry as CheckEntry);
                }
            } catch {
                /* a half-written line from a crash: skip it */
            }
        }
        return out;
    }

    return {
        userIds() {
            try {
                return readdirSync(options.usersRoot(), { withFileTypes: true })
                    .filter((entry) => entry.isDirectory() && existsSync(settingsFile(entry.name)))
                    .map((entry) => entry.name);
            } catch {
                return [];
            }
        },

        read(userId) {
            try {
                const parsed: unknown = JSON.parse(readFileSync(settingsFile(userId), "utf8"));
                const get = (key: string): unknown => (parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, key) : undefined);
                const rule = get("rule");
                const visionModel = get("visionModel");
                return {
                    enabled: get("enabled") === true,
                    rule: typeof rule === "string" ? rule.slice(0, MAX_RULE_CHARS) : "",
                    visionModel: typeof visionModel === "string" && MODEL_ID.test(visionModel) ? visionModel : DEFAULT_SETTINGS.visionModel,
                    fastAlerts: get("fastAlerts") === true,
                    fastSummary: get("fastSummary") === true,
                    summaryModel: ((model: unknown) => (typeof model === "string" && MODEL_ID.test(model) ? model : DEFAULT_SETTINGS.summaryModel))(get("summaryModel")),
                    alertZone: parseZone(get("alertZone")) ?? DEFAULT_SETTINGS.alertZone,
                };
            } catch {
                return { ...DEFAULT_SETTINGS };
            }
        },

        write(userId, patch) {
            const current = this.read(userId);
            const next: WatchSettings = { ...current };
            if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
            if (patch.rule !== undefined) {
                const rule = String(patch.rule).trim();
                if (rule.length > MAX_RULE_CHARS) throw new SettingsError(`The rule is too long: ${MAX_RULE_CHARS} characters at most.`);
                next.rule = rule;
            }
            if (patch.visionModel !== undefined) {
                const model = String(patch.visionModel).trim();
                if (model === "") next.visionModel = DEFAULT_SETTINGS.visionModel;
                else if (!MODEL_ID.test(model)) throw new SettingsError("That is not an OpenRouter model id (for example google/gemma-3-12b-it).");
                else next.visionModel = model;
            }
            if (patch.fastAlerts !== undefined) next.fastAlerts = patch.fastAlerts === true;
            if (patch.fastSummary !== undefined) next.fastSummary = patch.fastSummary === true;
            if (patch.summaryModel !== undefined) {
                const model = String(patch.summaryModel).trim();
                if (model === "") next.summaryModel = DEFAULT_SETTINGS.summaryModel;
                else if (!MODEL_ID.test(model)) throw new SettingsError("That is not an OpenRouter model id (for example google/gemma-3-4b-it).");
                else next.summaryModel = model;
            }
            if (patch.alertZone !== undefined) {
                const zone = parseZone(patch.alertZone);
                if (!zone) throw new SettingsError("That is not a usable area of the screen: four fractions from 0 to 1, at least 5% wide and tall.");
                next.alertZone = zone;
            }
            privateDir(dir(userId));
            const file = settingsFile(userId);
            const temp = `${file}.${process.pid}.tmp`;
            writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
            renameSync(temp, file);
            return next;
        },

        append(userId, entry) {
            privateDir(dir(userId));
            const file = logFile(userId);
            if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
            // A crash mid-line leaves one without its newline; start this entry on a line of its own.
            const lead = endsMidLine(file) ? "\n" : "";
            appendFileSync(file, `${lead}${JSON.stringify(entry)}\n`, { mode: 0o600 });
            chmodSync(file, 0o600);
        },

        log(userId, limit) {
            const file = logFile(userId);
            const all = [...readLines(`${file}.1`), ...readLines(file)];
            return all.slice(-limit).reverse();
        },

        askedSince(userId, sinceMs, kind) {
            const file = logFile(userId);
            return [...readLines(`${file}.1`), ...readLines(file)].filter(
                (entry) => entry.asked && entry.t >= sinceMs && (kind === "alert") === (entry.kind === "alert"),
            ).length;
        },

        subscriptionsFile: (userId) => join(dir(userId), "push-subscriptions.json"),
    };
}
