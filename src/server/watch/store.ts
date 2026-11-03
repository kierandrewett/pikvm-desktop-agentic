import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckEntry, WatchSettings } from "@pikvm/contracts/watch";
import { DEFAULT_VISION_MODEL, MAX_RULE_CHARS } from "./limits";

/**
 * What a user's watch keeps on disk, under `users/<id>/watch/`:
 *
 *   settings.json               on or off, the plain-English rule, the image model
 *   checks.jsonl                one line per check, so the person can see why a notification came or did not
 *   checks.jsonl.1              the previous log, kept when checks.jsonl passes `LOG_ROTATE_BYTES`
 *   push-subscriptions.json     the devices that asked for notifications (push.ts)
 *
 * Files are 0600 in a 0700 directory: the log holds what was on the screen.
 */

export const DEFAULT_SETTINGS: WatchSettings = { enabled: false, rule: "", visionModel: DEFAULT_VISION_MODEL };

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
    /** Checks in which a model was called at or after `sinceMs`. */
    askedSince(userId: string, sinceMs: number): number;
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

        askedSince(userId, sinceMs) {
            const file = logFile(userId);
            return [...readLines(`${file}.1`), ...readLines(file)].filter((entry) => entry.asked && entry.t >= sinceMs).length;
        },

        subscriptionsFile: (userId) => join(dir(userId), "push-subscriptions.json"),
    };
}
