/**
 * Approval requests: which ones the user answered (shared by the composer tray and the inline thread
 * marker), the pending list for a conversation, and the copy and risk hints the tray shows.
 */
import type { ApprovalRequestItem } from "@pikvm/chat-protocol";
import { useSyncExternalStore } from "react";
import { msg, translate } from "../../l10n/runtime";
import { useLive } from "../../lib/live";
import { answerApproval } from "../../lib/send";
import { parseArgs, toolKind } from "./turns";

const answers = new Map<string, boolean>();
const subs = new Set<() => void>();
let version = 0;

function subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
}

export function approvalAnswer(id: string): boolean | undefined {
    return answers.get(id);
}

export function useApprovalAnswer(id: string): boolean | undefined {
    return useSyncExternalStore(subscribe, () => answers.get(id));
}

/** Re-render when any approval is answered. */
export function useApprovalVersion(): number {
    return useSyncExternalStore(subscribe, () => version);
}

/** Send the answer once and remember it locally so every view updates at once. */
export function decideApproval(conversationId: string, id: string, approve: boolean): void {
    if (answers.has(id)) return;
    answers.set(id, approve);
    version++;
    for (const fn of subs) fn();
    answerApproval(conversationId, id, approve);
}

/** Unanswered approval requests of the running response, oldest first. */
export function usePendingApprovals(conversationId: string): ApprovalRequestItem[] {
    const live = useLive(conversationId);
    useSyncExternalStore(subscribe, () => version);
    if (!live || live.done) return [];
    return live.response.output.filter(
        (i): i is ApprovalRequestItem => i.type === "mcp_approval_request" && !answers.has(i.id),
    );
}

export interface ApprovalView {
    title: string;
    action: string;
    /** What the request does, for the tray icon. */
    kind: "run" | "edit" | "tool";
    /** Command or arguments for the code well. */
    code: string;
    lang: "bash" | "json";
    cwd?: string;
    risk?: string;
    /** Gateway approvals for a tool the server marked as destructive. */
    warning?: string;
    /** Short facts from the server's tool hints ("Read only", "Reaches outside systems"). */
    badges: string[];
    /** The MCP server id, for gateway approvals. */
    server?: string;
}

export const DESTRUCTIVE_WARNING = msg("thread-appr-destructive");

/** Badges from the MCP tool hints. A hint that is absent says nothing. */
export function hintBadges(hints: ApprovalRequestItem["hints"]): string[] {
    if (!hints) return [];
    const out: string[] = [];
    if (hints.readOnly) out.push(translate("thread-appr-read-only"));
    if (hints.destructive) out.push(translate("thread-appr-destructive-badge"));
    if (hints.idempotent) out.push(translate("thread-appr-idempotent"));
    if (hints.openWorld) out.push(translate("thread-appr-open-world"));
    return out;
}

const RISKS: [RegExp, string][] = [
    [/(^|[\s;&|(])sudo\s/, msg("thread-risk-sudo")],
    [/(^|[\s;&|(])rm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/, msg("thread-risk-rm")],
    [/(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/, msg("thread-risk-pipe-shell")],
    [/(^|[\s;&|(])(mkfs|dd|shred|fdisk|parted)\b/, msg("thread-risk-disks")],
    [/(^|[\s;&|(])chmod\s+-R|chown\s+-R/, msg("thread-risk-chmod")],
    [/git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/, msg("thread-risk-git")],
    [/>\s*\/(etc|usr|bin|boot|sys|dev)\//, msg("thread-risk-write-outside")],
    [/(^|\s)(\/etc|\/usr|\/boot|~\/\.ssh)\//, msg("thread-risk-touch-outside")],
];

export function riskHint(command: string): string | undefined {
    for (const [re, hint] of RISKS) if (re.test(command)) return translate(hint);
    return undefined;
}

/** Title, primary action label and code for one request. */
export function describeApproval(item: ApprovalRequestItem): ApprovalView {
    const view = describeBase(item);
    const gateway = item.reason !== undefined || item.hints !== undefined;
    // A risky PiKVM action says in words what it will do and which rules made it ask.
    const risky = item.reason === "risky";
    return {
        ...view,
        badges: hintBadges(item.hints),
        warning: item.reason === "destructive" ? translate(DESTRUCTIVE_WARNING) : undefined,
        risk: risky && item.reasons?.length ? item.reasons.join(", ") : view.risk,
        server: gateway ? item.server_label : undefined,
        title: risky && item.summary ? item.summary : gateway ? translate("thread-appr-use", { name: item.name }) : view.title,
    };
}

function describeBase(item: ApprovalRequestItem): Omit<ApprovalView, "badges" | "warning" | "server"> {
    const args = parseArgs(item.arguments) ?? {};
    const kind = toolKind(item.name);
    const command =
        typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
    const cwd = ["cwd", "workdir", "working_directory", "dir"]
        .map((k) => args[k])
        .find((v): v is string => typeof v === "string");
    const path = ["path", "file_path", "filePath"].map((k) => args[k]).find((v): v is string => typeof v === "string");
    if (command !== undefined) {
        return {
            kind: "run",
            title: translate("thread-appr-run-title"),
            action: translate("thread-appr-run"),
            code: command,
            lang: "bash",
            cwd,
            risk: riskHint(command),
        };
    }
    if (kind === "edit") {
        return {
            kind: "edit",
            title: translate("thread-appr-edit-title"),
            action: translate("thread-appr-allow"),
            code: path ?? JSON.stringify(args, null, 2),
            lang: path ? "bash" : "json",
            cwd,
            risk:
                path && /^(\/etc|\/usr|\/boot|~\/\.ssh)\//.test(path)
                    ? translate("thread-risk-write-outside")
                    : undefined,
        };
    }
    const server = item.server_label && item.server_label !== "agent" ? item.server_label : undefined;
    return {
        kind: "tool",
        title: server
            ? translate("thread-appr-use-tool", { server })
            : translate("thread-appr-use", { name: item.name }),
        action: translate("thread-appr-allow"),
        code: Object.keys(args).length ? JSON.stringify(args, null, 2) : item.name,
        lang: "json",
        cwd,
    };
}
