/**
 * MCP elicitation: an MCP server asks the user for input in the middle of a tool call. This module holds the
 * pending list for a conversation, the answers sent from this page (so the tray closes at once), and the pure
 * parts of the form: reading the flat schema, checking values against it and building the answer.
 *
 * Elicitation items only exist in the live response. After a reload the thread shows nothing for them.
 */
import type { McpElicitationItem, McpElicitationValue } from "@pikvm/chat-protocol";
import { useSyncExternalStore } from "react";
import { useLive } from "../../lib/live";
import { registerSessionReset } from "../../lib/session-reset";
import { answerElicitation } from "../../lib/send";
import { translate } from "../../l10n/runtime";

type Action = "accept" | "decline" | "cancel";

/** Item id -> the action sent from this page. */
const sent = new Map<string, Action>();
const subs = new Set<() => void>();
let version = 0;

function bump() {
    version++;
    for (const fn of subs) fn();
}

function subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
}

const unregisterSessionReset = registerSessionReset("mcp-elicitations", () => {
    sent.clear();
    bump();
});
import.meta.hot?.dispose(unregisterSessionReset);

/** Send the answer once and remember it locally, so the tray and the thread record update together. */
export function respondElicitation(
    conversationId: string,
    id: string,
    action: Action,
    content?: Record<string, McpElicitationValue>,
): void {
    if (sent.has(id)) return;
    sent.set(id, action);
    bump();
    answerElicitation(conversationId, id, action, action === "accept" ? content : undefined);
}

/** The action sent from this page for an item, if any. */
export function useElicitationAnswer(id: string): Action | undefined {
    return useSyncExternalStore(subscribe, () => sent.get(id));
}

/** Elicitations of the running response that nobody answered yet, oldest first. */
export function usePendingElicitations(conversationId: string): McpElicitationItem[] {
    const live = useLive(conversationId);
    useSyncExternalStore(subscribe, () => version);
    if (!live || live.done) return [];
    return live.response.output.filter(
        (i): i is McpElicitationItem =>
            i.type === "chat.mcp_elicitation" && i.status === "in_progress" && !sent.has(i.id),
    );
}

// Schema

export interface FieldOption {
    value: string;
    title: string;
}

export interface Field {
    key: string;
    title: string;
    description?: string;
    required: boolean;
    kind: "text" | "number" | "integer" | "boolean" | "select" | "multi";
    format?: "email" | "uri" | "date" | "date-time";
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    options: FieldOption[];
    /** Start value as the form keeps it. */
    initial: string | boolean | string[];
}

/** What the form keeps: text for every input, a boolean for a switch, a list for a multi select. */
export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function optionsOf(list: unknown, names: unknown): FieldOption[] {
    if (!Array.isArray(list)) return [];
    const titles = Array.isArray(names) ? names : [];
    const out: FieldOption[] = [];
    list.forEach((entry, i) => {
        if (typeof entry === "string") out.push({ value: entry, title: str(titles[i]) ?? entry });
        else if (isRecord(entry) && typeof entry.const === "string") {
            out.push({ value: entry.const, title: str(entry.title) ?? entry.const });
        }
    });
    return out;
}

/** The fields of a flat schema, in the order the server sent them. Unsupported properties are left out. */
export function fieldsOf(schema: Record<string, unknown> | undefined): Field[] {
    const props = isRecord(schema?.properties) ? schema.properties : {};
    const required = new Set(
        Array.isArray(schema?.required) ? schema.required.filter((r) => typeof r === "string") : [],
    );
    const fields: Field[] = [];
    for (const [key, raw] of Object.entries(props)) {
        if (!isRecord(raw)) continue;
        const base = {
            key,
            title: str(raw.title) ?? key,
            description: str(raw.description),
            required: required.has(key),
            options: [] as FieldOption[],
        };
        const def = raw.default;
        if (raw.type === "string") {
            const options = raw.oneOf ? optionsOf(raw.oneOf, undefined) : optionsOf(raw.enum, raw.enumNames);
            const format = ["email", "uri", "date", "date-time"].find((f) => f === raw.format) as Field["format"];
            fields.push({
                ...base,
                kind: options.length ? "select" : "text",
                format,
                minLength: num(raw.minLength),
                maxLength: num(raw.maxLength),
                options,
                initial: typeof def === "string" ? def : "",
            });
        } else if (raw.type === "number" || raw.type === "integer") {
            fields.push({
                ...base,
                kind: raw.type,
                minimum: num(raw.minimum),
                maximum: num(raw.maximum),
                initial: typeof def === "number" ? String(def) : "",
            });
        } else if (raw.type === "boolean") {
            fields.push({ ...base, kind: "boolean", initial: def === true });
        } else if (raw.type === "array" && isRecord(raw.items)) {
            const options = raw.items.anyOf
                ? optionsOf(raw.items.anyOf, undefined)
                : optionsOf(raw.items.enum, raw.items.enumNames);
            fields.push({
                ...base,
                kind: "multi",
                options,
                minItems: num(raw.minItems),
                maxItems: num(raw.maxItems),
                initial: Array.isArray(def) ? def.filter((d): d is string => typeof d === "string") : [],
            });
        }
    }
    return fields;
}

export function initialValues(fields: readonly Field[]): FormValues {
    return Object.fromEntries(fields.map((f) => [f.key, f.initial]));
}

function validDate(text: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return (
        d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
    );
}

const isEmpty = (f: Field, v: FormValue | undefined) =>
    f.kind === "boolean" ? false : Array.isArray(v) ? v.length === 0 : (v ?? "") === "";

/** A message in plain words when the value breaks the schema, else undefined. */
export function checkField(f: Field, v: FormValue | undefined): string | undefined {
    if (isEmpty(f, v)) return f.required ? translate("thread-form-required") : undefined;
    switch (f.kind) {
        case "boolean":
            return undefined;
        case "select":
            return f.options.some((o) => o.value === v) ? undefined : translate("thread-form-choose-option");
        case "multi": {
            const list = v as string[];
            if (f.minItems !== undefined && list.length < f.minItems)
                return translate("thread-form-min-items", { count: f.minItems });
            if (f.maxItems !== undefined && list.length > f.maxItems)
                return translate("thread-form-max-items", { count: f.maxItems });
            return undefined;
        }
        case "number":
        case "integer": {
            const text = String(v).trim();
            const n = Number(text);
            if (text === "" || !Number.isFinite(n)) return translate("thread-form-number");
            if (f.kind === "integer" && !Number.isInteger(n)) return translate("thread-form-integer");
            if (f.minimum !== undefined && n < f.minimum) return translate("thread-form-min", { value: f.minimum });
            if (f.maximum !== undefined && n > f.maximum) return translate("thread-form-max", { value: f.maximum });
            return undefined;
        }
        case "text": {
            const text = String(v);
            if (f.minLength !== undefined && text.length < f.minLength)
                return translate("thread-form-min-length", { count: f.minLength });
            if (f.maxLength !== undefined && text.length > f.maxLength)
                return translate("thread-form-max-length", { count: f.maxLength });
            if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return translate("thread-form-email");
            if (f.format === "uri" && !URL.canParse(text)) return translate("thread-form-uri");
            if (f.format === "date" && !validDate(text)) return translate("thread-form-date");
            if (f.format === "date-time" && !(/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text)))) {
                return translate("thread-form-datetime");
            }
            return undefined;
        }
    }
}

/** Messages by field key for every field that fails. */
export function checkForm(fields: readonly Field[], values: FormValues): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const f of fields) {
        const message = checkField(f, values[f.key]);
        if (message) errors[f.key] = message;
    }
    return errors;
}

/** The answer content: one typed value per filled field. Empty optional fields are left out. */
export function contentOf(fields: readonly Field[], values: FormValues): Record<string, McpElicitationValue> {
    const out: Record<string, McpElicitationValue> = {};
    for (const f of fields) {
        const v = values[f.key];
        if (f.kind === "boolean") out[f.key] = v === true;
        else if (isEmpty(f, v)) continue;
        else if (f.kind === "number" || f.kind === "integer") out[f.key] = Number(String(v).trim());
        else out[f.key] = v as string | string[];
    }
    return out;
}

// URL mode

export interface UrlView {
    /** The address split around the host, so the host can be drawn on its own. */
    before: string;
    host: string;
    after: string;
    /** The host has a punycode label (xn--), which can hide look-alike letters. */
    punycode: boolean;
    /** Only http and https can be opened. */
    openable: boolean;
}

export function urlView(raw: string | undefined): UrlView {
    const text = raw ?? "";
    if (!URL.canParse(text)) return { before: "", host: "", after: text, punycode: false, openable: false };
    const u = new URL(text);
    // The host as written, so the text on screen matches the address that opens.
    const at = text.indexOf(`//`) + 2;
    const hostAt = text.indexOf(u.host, at) >= 0 ? text.indexOf(u.host, at) : at;
    return {
        before: text.slice(0, hostAt),
        host: u.host,
        after: text.slice(hostAt + u.host.length),
        punycode: u.hostname.split(".").some((l) => l.startsWith("xn--")),
        openable: u.protocol === "https:" || u.protocol === "http:",
    };
}

/** Open a link the user chose. No referrer, no opener. */
export function openLink(raw: string): void {
    window.open(raw, "_blank", "noopener,noreferrer");
}
