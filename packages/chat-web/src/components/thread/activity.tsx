/**
 * Agent activity for one turn: reasoning, tool calls, approvals, questions and intermediate text, under a
 * one-line header. Design and evidence: docs/spec/tool-call-reference-notes.md.
 *
 * - Header: while running, the thinking glyph, the newest step's label and a live clock; when done, a
 *   summary of verbs ("Ran 2 commands, edited a file · 1 failed · 13s"). The caret comes last.
 * - Done: collapsed to the header. Running: open, so the steps show as they happen.
 * - Steps: one quiet row each, `[verb] [subject] [note] [caret]` (activity/shared.tsx `StepRow`). Raw output
 *   (file contents, command output, diffs) stays behind the row's disclosure, capped with "Show all".
 * - Failure is a word on the row ("exit 101", "Failed"), never a red card. A tool cut off by Stop reads
 *   "Stopped" and is not counted as failed; the run-end note in turn.tsx says that the turn was stopped.
 *
 * Live items are mutated in place by lib/live.ts, so step components take primitive props and are
 * memoised on them: a streaming delta re-renders only the step that changed.
 */
import type {
    ApprovalRequestItem,
    AskRequestItem,
    FunctionCallItem,
    FunctionCallOutputItem,
    McpElicitationItem,
    OutputItem,
    RunEndItem,
} from "@pikvm/chat-protocol";
import { ArrowSquareOutIcon, CaretRightIcon } from "@pikvm/icons";
import { Button } from "../../ui/index";
import { Fragment, memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToolProgress } from "../../lib/live";
import { captureSessionEpoch } from "../../lib/queries";
import { activeLocalization, msg, translate } from "../../l10n/runtime";
import { useT } from "../../l10n/provider";
import { Elapsed, Lines, StepRow, textLines, type Line, type StepState } from "./activity/shared";
import { ElicitationStep, ELICITATION_WAITING_LABEL } from "./elicitation-record";
import { approvalAnswer, describeApproval, useApprovalAnswer, useApprovalVersion } from "./approvals";
import { ThreadContext } from "./context";
import { useHighlight } from "./highlight";
import { stripAnsi } from "./local-notices";
import { Markdown } from "./markdown";
import { QUESTION_WAITING_LABEL, QuestionRecord } from "./questions/question-record";
import { isWebTool, urlsIn } from "./sources";
import { subagentDetail, SubagentsStep, subagentRunsOf } from "./subagents";
import { ThinkingIndicator, thinkingStatus } from "./thinking-indicator";
import { argSummary, formatDuration, historyDuration, messageText, parseArgs, toolKind, type Turn } from "./turns";
import { entryOf, fetchOf, isWebFetchCall, isWebSearchCall, WebFetchStep, WebSearchStep } from "./web-search";
import { TodoStep } from "./activity/todo-step";

// Kinds and labels

type StepKind =
    "terminal" | "edit" | "read" | "search" | "web-search" | "fetch" | "browser" | "subagents" | "connector";

/** Kind of one call from its name and arguments: `task` runs subagents, `read` of a URL reads a page. */
function callKind(rawName: string, args: string): StepKind {
    const name = xdMcpName(rawName, args) ?? rawName;
    if (name === "task") return "subagents";
    // MCP tools keep their server's name, even when the tool searches or fetches ("mcp__github__search_issues").
    if (/^mcp__/.test(name)) return /browser|playwright|puppeteer/i.test(name) ? "browser" : "connector";
    if (isWebFetchCall(name, args)) return "fetch";
    if (isWebSearchCall(name)) return "web-search";
    const n = name.toLowerCase();
    if (/browser|playwright|puppeteer/.test(n)) return "browser";
    if (isWebTool(n)) return /search|query/.test(n) ? "web-search" : "fetch";
    const k = toolKind(n);
    if (k === "terminal" || k === "edit" || k === "read" || k === "search") return k;
    return "connector";
}

/** Calls whose question record (`chat.ask_request`) stands in for the raw tool step. */
function askedCalls(items: readonly OutputItem[]): Set<string> {
    return new Set(items.flatMap((i) => (i.type === "chat.ask_request" && i.call_id ? [i.call_id] : [])));
}

/** Number of subagents a `task` call asked for (0 when the arguments are still streaming). */
function taskCount(args: string): number {
    const tasks = parseArgs(args)?.tasks;
    return Array.isArray(tasks) ? tasks.length : 0;
}

const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;

/**
 * A tool path as a path in the conversation workspace, if it is one: relative paths as they are,
 * sandbox paths under /workspace/chats/<id>/ with that prefix removed. Other absolute paths: undefined.
 */
function workspacePath(p: string, conversationId: string): string | undefined {
    const prefix = `/workspace/chats/${conversationId}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    if (p.startsWith("/") || p.startsWith("~")) return undefined;
    return p.replace(/^\.\//, "");
}

/**
 * The runtime sends some MCP tools as a `write` to `xd://mcp__<server>_<tool>`. Returns that tool name, or
 * undefined for any other call.
 */
function xdMcpName(name: string, args: string): string | undefined {
    if (name !== "write") return undefined;
    const path = parseArgs(args)?.path;
    return typeof path === "string" && path.startsWith("xd://mcp__") ? path.slice("xd://".length) : undefined;
}

/**
 * Server and tool of an MCP-style name: "mcp__github__search", "mcp__github_search" or "github.search" ->
 * ["github", "search"]. The single-underscore form cannot tell where the server name ends, so it splits at the
 * first underscore.
 */
function splitToolName(name: string): [string | undefined, string] {
    const bare = name.replace(/^mcp__/, "");
    if (name.startsWith("mcp__") && !/__|\.|\//.test(bare) && bare.includes("_")) {
        const at = bare.indexOf("_");
        return [bare.slice(0, at), bare.slice(at + 1).replace(/_/g, " ")];
    }
    const parts = bare.split(/__|\.|\//);
    return parts.length > 1 ? [parts[0], parts.slice(1).join(" ")] : [undefined, name];
}

// Reading tool results

/**
 * A command's output without the runtime's footer ("Wall time: 0.23 seconds", "Command exited with code 7",
 * "(no output)"), with the exit code and wall time it reported.
 */
function commandResult(output: string | undefined): { body: string; code?: number; wallMs?: number } {
    let body = stripAnsi(output ?? "");
    const code = body.match(/(?:^|\n)\s*(?:Command )?exit(?:ed)?(?:\s+with)?\s+(?:status|code)[:\s]+(\d+)\s*$/i);
    if (code) body = body.slice(0, code.index);
    const wall = body.match(/(?:^|\n)\s*Wall time:\s*([\d.]+)\s*seconds?\s*$/i);
    if (wall) body = body.slice(0, wall.index);
    body = body.replace(/^\s*\(no output\)\s*$/m, "");
    return { body, code: code ? Number(code[1]) : undefined, wallMs: wall ? Number(wall[1]) * 1000 : undefined };
}

const HASH_HEADER = /^\s*\[[^\]\n]+#[0-9A-Fa-f]+\]\s*$/;

/** A file read's lines: the runtime's `[path#HASH]` header dropped and its `12|` or `12:` prefixes moved to `n`. */
function fileLines(output: string): Line[] {
    const raw = stripAnsi(output).replace(/\s+$/, "").split("\n");
    if (raw.length && HASH_HEADER.test(raw[0]!)) raw.shift();
    const numbered = raw.filter((l) => /^\s*\d+[|:]/.test(l)).length;
    if (numbered < Math.max(1, raw.filter((l) => l.trim()).length / 2)) return textLines(raw.join("\n"));
    return raw.map((l) => {
        const m = l.match(/^\s*(\d+)[|:](.*)$/);
        return m ? { n: Number(m[1]), text: m[2]! } : { text: l };
    });
}

const lineCount = (s: unknown) => (typeof s === "string" && s ? s.replace(/\n$/, "").split("\n").length : 0);

interface Changes {
    path?: string;
    add: number;
    del: number;
    lines: Line[];
}

/** Changes from the unified diff the runtime reported (`diff` on the result): context, removed and added lines. */
function changesFromDiff(diff: string, path: string | undefined): Changes {
    const out: Changes = { path, add: 0, del: 0, lines: [] };
    let oldN = 0;
    let newN = 0;
    for (const l of diff.replace(/\n$/, "").split("\n")) {
        const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (hunk) {
            oldN = Number(hunk[1]);
            newN = Number(hunk[2]);
            continue;
        }
        if (l.startsWith("+")) (out.lines.push({ n: newN++, text: l.slice(1), kind: "add" }), out.add++);
        else if (l.startsWith("-")) (out.lines.push({ n: oldN++, text: l.slice(1), kind: "del" }), out.del++);
        else if (l.startsWith(" ")) (out.lines.push({ n: newN++, text: l.slice(1) }), oldN++);
    }
    return out;
}

/**
 * What an edit or write changes, from its arguments: a whole file (`content`), text replacements
 * (`oldText`/`newText`, `old_string`/`new_string`, `edits[]`) or the runtime's anchored patch (`input`:
 * `[path#HASH]` then ops such as `PUT 4.=4:` with `+` lines). Undefined when the arguments say nothing.
 */
function changesOf(args: Record<string, unknown> | undefined): Changes | undefined {
    if (!args) return undefined;
    const path = ["path", "file_path", "filePath"].map((k) => args[k]).find((v): v is string => typeof v === "string");
    if (typeof args.content === "string") {
        const lines = args.content.replace(/\n$/, "").split("\n");
        return { path, add: lines.length, del: 0, lines: lines.map((text) => ({ text, kind: "add" })) };
    }
    if (typeof args.input === "string" && /\*\*\* Begin Patch|^\s*\[[^\]]+#/.test(args.input)) {
        const out: Changes = { add: 0, del: 0, lines: [] };
        for (const l of args.input.split("\n")) {
            const header = l.match(/^\s*\[([^\]\n]+)#[0-9A-Fa-f]+\]\s*$/);
            if (header) {
                out.path ??= header[1];
                continue;
            }
            if (l.startsWith("+")) {
                out.add++;
                out.lines.push({ text: l.slice(1), kind: "add" });
                continue;
            }
            // An op that replaces or removes a line range: "PUT 4.=6:", "SWAP 4.=4:", "CUT 9.=12", "DEL 3".
            const op = l.match(/^(?:PUT|SWAP|CUT|DEL)(?:\.[A-Z]+)*\s+(\d+)(?:\.=(\d+))?/);
            if (op) out.del += op[2] ? Number(op[2]) - Number(op[1]) + 1 : 1;
        }
        return out;
    }
    const pairs: [unknown, unknown][] = [];
    if ("newText" in args || "oldText" in args) pairs.push([args.oldText, args.newText]);
    if ("new_string" in args || "old_string" in args) pairs.push([args.old_string, args.new_string]);
    if (Array.isArray(args.edits))
        for (const e of args.edits as Record<string, unknown>[])
            pairs.push([e.oldText ?? e.old_string, e.newText ?? e.new_string]);
    if (!pairs.length) return undefined;
    const lines: Line[] = [];
    for (const [o, n] of pairs) {
        if (typeof o === "string" && o) for (const text of o.split("\n")) lines.push({ text, kind: "del" });
        if (typeof n === "string" && n) for (const text of n.split("\n")) lines.push({ text, kind: "add" });
    }
    return {
        path,
        add: pairs.reduce((s, [, n]) => s + lineCount(n), 0),
        del: pairs.reduce((s, [o]) => s + lineCount(o), 0),
        lines,
    };
}

/** The path a call works on: its path argument, or the file named in an anchored patch. */
function pathOf(args: string): string | undefined {
    const a = parseArgs(args);
    const p = ["path", "file_path", "filePath"].map((k) => a?.[k]).find((v): v is string => typeof v === "string");
    return p ?? changesOf(a)?.path;
}

// Step states

const ABORTED = /\babort|interrupt|cancel/i;
/** Exit codes of a process ended by SIGINT, SIGKILL or SIGTERM. */
const SIGNAL_EXITS: ReadonlySet<number> = new Set([130, 137, 143]);

/**
 * How each call in the group ended. A call with no result in a finished turn was cut off. An error result
 * in a stopped turn is the stop itself when it is the last call or says it was aborted, not a failure.
 */
function callStates(items: readonly OutputItem[], running: boolean, end?: RunEndItem): Map<string, StepState> {
    const outputs = new Map<string, FunctionCallOutputItem>();
    for (const it of items) if (it.type === "function_call_output") outputs.set(it.call_id, it);
    const calls = items.filter((i): i is FunctionCallItem => i.type === "function_call");
    const last = calls.at(-1)?.call_id;
    const stopped = end?.status === "cancelled";
    const states = new Map<string, StepState>();
    for (const c of calls) {
        const out = outputs.get(c.call_id);
        let state: StepState;
        if (!out || out.status === "in_progress") state = running ? "running" : "stopped";
        else if (c.name === "task") {
            const runs = out.subagents ?? [];
            state = runs.some((r) => r.status === "failed")
                ? "failed"
                : runs.some((r) => r.status === "cancelled") || (stopped && out.is_error)
                  ? "stopped"
                  : out.is_error
                    ? "failed"
                    : "done";
        } else if (out.is_error)
            state =
                out.aborted === true
                    ? "stopped"
                    : stopped && (c.call_id === last || ABORTED.test(out.output))
                      ? "stopped"
                      : "failed";
        else {
            const code =
                callKind(c.name, c.arguments) === "terminal"
                    ? (out.exit_code ?? commandResult(out.output).code)
                    : undefined;
            // A command that Stop killed exits with a signal code (128 + 2, 9 or 15) or says it was aborted. That
            // is the stop itself, not a failure of the command.
            const killed = code !== undefined && SIGNAL_EXITS.has(code) && (stopped || ABORTED.test(out.output));
            state = killed ? "stopped" : code !== undefined && code !== 0 ? "failed" : "done";
        }
        states.set(c.call_id, state);
    }
    return states;
}

/** The run-end item of a turn, if it ended early. */
const endOf = (items: readonly OutputItem[]) => {
    const last = items.at(-1);
    return last?.type === "chat.run_end" ? last : undefined;
};

// Header labels

/** Words for the live header while a step runs ("Searching the web", "Running ls -la"). */
function runningLabel(name: string, args: string): string {
    const summary = argSummary(args);
    switch (callKind(name, args)) {
        case "terminal":
            return summary
                ? translate("thread-act-running-named", { name: summary })
                : translate("thread-act-running-command");
        case "edit": {
            const p = pathOf(args);
            return p
                ? translate("thread-act-editing-named", { name: basename(p) })
                : translate("thread-act-editing-file");
        }
        case "read":
            return summary
                ? translate("thread-act-reading-named", { name: basename(summary) })
                : translate("thread-act-reading-files");
        case "search":
            return translate("thread-act-searching-files");
        case "web-search":
            return translate("thread-act-searching-web");
        case "fetch": {
            const host = urlsIn(args)[0]?.host;
            return host ? translate("thread-act-reading-named", { name: host }) : translate("thread-act-reading-page");
        }
        case "browser":
            return translate("thread-act-using-browser");
        case "subagents": {
            const n = taskCount(args);
            return n
                ? translate("thread-act-running-subagents", { count: n })
                : translate("thread-act-starting-subagents");
        }
        case "connector":
            return name === "todo"
                ? translate("thread-act-updating-plan")
                : translate("thread-act-using-named", { name: splitToolName(xdMcpName(name, args) ?? name)[1] });
    }
}

/** Header words for a running group, from its newest step. */
function liveGroupLabel(items: readonly OutputItem[]): string {
    const asked = askedCalls(items);
    for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!;
        if (it.type === "mcp_approval_request") {
            if (approvalAnswer(it.id) === undefined) return translate("thread-act-waiting-approval");
            continue;
        }
        if (it.type === "chat.ask_request") {
            if (it.status === "in_progress") return translate(QUESTION_WAITING_LABEL);
            continue;
        }
        if (it.type === "chat.mcp_elicitation") {
            if (it.status === "in_progress") return translate(ELICITATION_WAITING_LABEL);
            continue;
        }
        if (it.type === "function_call" && !asked.has(it.call_id)) return runningLabel(it.name, it.arguments);
        if (it.type === "reasoning")
            return thinkingStatus(it.content.map((c) => c.text).join("")) ?? translate("thread-act-thinking");
    }
    return translate("thread-act-thinking");
}

/** "Ran 2 commands, edited a file, read a file"; "Thought" for a group with reasoning only. */
export function summarise(items: readonly OutputItem[]): string {
    let thought = false;
    const counts = new Map<StepKind, number>();
    const tools = new Set<string>();
    const asked = askedCalls(items);
    let questions = 0;
    let planned = false;
    for (const it of items) {
        if (it.type === "reasoning") thought = true;
        if (it.type === "chat.ask_request") questions += it.questions.length;
        if (it.type !== "function_call" || asked.has(it.call_id)) continue;
        if (it.name === "todo") {
            planned = true;
            continue;
        }
        const k = callKind(it.name, it.arguments);
        counts.set(k, (counts.get(k) ?? 0) + (k === "subagents" ? Math.max(1, taskCount(it.arguments)) : 1));
        if (k === "connector") tools.add(splitToolName(xdMcpName(it.name, it.arguments) ?? it.name)[1]);
    }
    const parts: string[] = [];
    if (planned) parts.push(translate("thread-act-sum-plan"));
    const n = (k: StepKind) => counts.get(k) ?? 0;
    if (questions) parts.push(translate("thread-act-sum-asked", { count: questions }));
    if (n("terminal")) parts.push(translate("thread-act-sum-ran", { count: n("terminal") }));
    if (n("edit")) parts.push(translate("thread-act-sum-edited", { count: n("edit") }));
    if (n("read")) parts.push(translate("thread-act-sum-read-files", { count: n("read") }));
    if (n("search")) parts.push(translate("thread-act-sum-searched-files"));
    if (n("web-search")) parts.push(translate("thread-act-sum-searched-web"));
    if (n("fetch")) parts.push(translate("thread-act-sum-read-pages", { count: n("fetch") }));
    if (n("browser")) parts.push(translate("thread-act-sum-browser"));
    if (n("subagents")) parts.push(translate("thread-act-sum-subagents", { count: n("subagents") }));
    if (tools.size) {
        parts.push(
            tools.size === 1
                ? translate("thread-act-sum-tool", { name: [...tools][0]! })
                : translate("thread-act-sum-tools", { count: tools.size }),
        );
    }
    const s = parts.join(", ") || (thought ? translate("thread-act-sum-thought") : translate("thread-act-sum-worked"));
    return s[0]!.toLocaleUpperCase(activeLocalization().locale) + s.slice(1);
}

// Steps

/** Syntax-highlighted command, for a command's detail. Keeps the session-epoch guards of the highlighter. */
function Command({ code }: { code: string }) {
    const [ownerEpoch] = useState(captureSessionEpoch);
    const html = useHighlight("bash", code, { ownerEpoch });
    return html !== undefined ? (
        <pre className="act-command md-pre" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
        <pre className="act-command md-pre">{code}</pre>
    );
}

/** "Open config.rs" in the side panel, for a file in the conversation workspace. */
function OpenFile({ path }: { path: string }) {
    const t = useT();
    const { openPanel } = useContext(ThreadContext);
    if (!openPanel) return null;
    return (
        <Button variant="link" onClick={() => openPanel({ kind: "file", path })}>
            <ArrowSquareOutIcon size={14} aria-hidden />
            {t("thread-act-open-file", { name: basename(path) })}
        </Button>
    );
}

const noteFor = (state: StepState, failed = translate("thread-act-failed")) =>
    state === "failed" ? failed : state === "stopped" ? translate("thread-act-stopped") : undefined;

/** A tool call that is not a web search, page read or subagent run. */
const ToolStep = memo(function ToolStep({
    name,
    args,
    output,
    state,
    facts,
}: {
    name: string;
    args: string;
    output?: string;
    state: StepState;
    /** Facts the server forwards from the tool's result; they win over what the text and arguments suggest. */
    facts?: Pick<FunctionCallOutputItem, "diff" | "exit_code" | "wall_time_ms">;
}) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const kind = callKind(name, args);
    const parsed = parseArgs(args);
    const running = state === "running";
    const hasOutput = output !== undefined && output.trim() !== "";

    if (kind === "terminal") {
        const command =
            typeof parsed?.command === "string" ? parsed.command : typeof parsed?.cmd === "string" ? parsed.cmd : "";
        const parsedResult = commandResult(output);
        const result = {
            ...parsedResult,
            code: facts?.exit_code ?? parsedResult.code,
            wallMs: facts?.wall_time_ms ?? parsedResult.wallMs,
        };
        const firstLine = command.split("\n")[0] ?? "";
        const showCommand = command.includes("\n") || command.length > 72;
        const lines = textLines(result.body);
        const failedCode =
            state === "failed" && result.code !== undefined ? t("thread-act-exit", { code: result.code }) : undefined;
        return (
            <StepRow
                kind="terminal"
                state={state}
                verb={running ? t("thread-act-verb-running") : t("thread-act-verb-ran")}
                subject={firstLine || name}
                mono
                title={command}
                meta={result.wallMs !== undefined && result.wallMs >= 1000 ? formatDuration(result.wallMs) : undefined}
                note={failedCode ?? noteFor(state)}
                detail={
                    showCommand || lines.length || state === "failed"
                        ? () => (
                              <>
                                  {showCommand && <Command code={command} />}
                                  {lines.length > 0 ? (
                                      <Lines
                                          lines={lines}
                                          label={t("thread-act-output")}
                                          heading={
                                              failedCode ? t("thread-act-exit-code", { code: result.code! }) : undefined
                                          }
                                          bad={!!failedCode}
                                          copyText={result.body}
                                      />
                                  ) : (
                                      !running && <p className="act-empty">{t("thread-act-no-output")}</p>
                                  )}
                              </>
                          )
                        : undefined
                }
            />
        );
    }

    if (kind === "edit") {
        const argChanges = changesOf(parsed);
        const path = argChanges?.path ?? argSummary(args);
        const changes = facts?.diff && state === "done" ? changesFromDiff(facts.diff, path) : argChanges;
        const file = path ? workspacePath(path, conversationId) : undefined;
        const writes = typeof parsed?.content === "string";
        const failed = state === "failed" && hasOutput;
        return (
            <StepRow
                kind="edit"
                state={state}
                verb={
                    writes
                        ? running
                            ? t("thread-act-verb-writing")
                            : t("thread-act-verb-wrote")
                        : running
                          ? t("thread-act-verb-editing")
                          : t("thread-act-verb-edited")
                }
                subject={path ? basename(path) : undefined}
                mono
                title={path}
                meta={
                    changes && (changes.add || changes.del) ? (
                        <span
                            className="act-stat"
                            aria-label={t("thread-act-lines-changed", { added: changes.add, removed: changes.del })}
                        >
                            <span className="text-added">+{changes.add}</span>
                            {changes.del > 0 && <span className="text-deleted"> -{changes.del}</span>}
                        </span>
                    ) : undefined
                }
                note={noteFor(state)}
                detail={
                    failed || changes?.lines.length
                        ? () =>
                              failed ? (
                                  <Lines
                                      lines={textLines(stripAnsi(output!))}
                                      label={t("thread-act-error")}
                                      heading={t("thread-act-error")}
                                      bad
                                  />
                              ) : (
                                  <Lines
                                      lines={changes!.lines}
                                      label={t("thread-act-changes")}
                                      footer={file && !running ? <OpenFile path={file} /> : undefined}
                                  />
                              )
                        : undefined
                }
            />
        );
    }

    if (kind === "read") {
        const path = argSummary(args);
        const file = path ? workspacePath(path, conversationId) : undefined;
        const lines = hasOutput && state === "done" ? fileLines(output!) : [];
        const listing = name.toLowerCase() === "ls";
        return (
            <StepRow
                kind="read"
                state={state}
                verb={
                    listing
                        ? running
                            ? t("thread-act-verb-listing")
                            : t("thread-act-verb-listed")
                        : running
                          ? t("thread-act-verb-reading")
                          : t("thread-act-verb-read")
                }
                subject={path ? (listing ? path : basename(path)) : listing ? "." : undefined}
                mono
                title={path}
                meta={
                    lines.length
                        ? t(listing ? msg("thread-act-entries") : msg("thread-act-lines"), { count: lines.length })
                        : undefined
                }
                note={noteFor(state)}
                detail={
                    hasOutput && !running
                        ? () =>
                              state === "done" ? (
                                  <Lines
                                      lines={lines}
                                      label={path ? basename(path) : t("thread-act-file")}
                                      preview={6}
                                      footer={file && !listing ? <OpenFile path={file} /> : undefined}
                                  />
                              ) : (
                                  <Lines
                                      lines={textLines(stripAnsi(output!))}
                                      label={t("thread-act-result")}
                                      heading={state === "failed" ? t("thread-act-error") : undefined}
                                      bad={state === "failed"}
                                  />
                              )
                        : undefined
                }
            />
        );
    }

    if (kind === "search") {
        const pattern = argSummary(args);
        const lines = hasOutput ? textLines(stripAnsi(output!)) : [];
        return (
            <StepRow
                kind="search"
                state={state}
                verb={running ? t("thread-act-verb-searching") : t("thread-act-verb-searched")}
                subject={pattern}
                mono
                title={pattern}
                meta={state === "done" ? t("thread-act-matches", { count: lines.length }) : undefined}
                note={noteFor(state)}
                detail={
                    lines.length && !running
                        ? () => (
                              <Lines
                                  lines={lines}
                                  label={t("thread-act-matches-label")}
                                  heading={state === "failed" ? t("thread-act-error") : undefined}
                                  bad={state === "failed"}
                              />
                          )
                        : undefined
                }
            />
        );
    }

    // MCP tools, the browser and anything else: server and tool, then the arguments and the result.
    const [server, tool] = splitToolName(xdMcpName(name, args) ?? name);
    const entries = Object.entries(parsed ?? {}).filter(([k]) => k !== "i");
    return (
        <StepRow
            kind={kind}
            state={state}
            verb={running ? t("thread-act-verb-using") : t("thread-act-verb-used")}
            subject={
                <>
                    {server && <span className="act-subject-quiet">{server} · </span>}
                    {tool}
                </>
            }
            title={name}
            note={noteFor(state)}
            detail={
                entries.length || hasOutput
                    ? () => (
                          <>
                              {entries.length > 0 && (
                                  <dl className="act-args">
                                      {entries.slice(0, 12).map(([k, v]) => {
                                          const value = typeof v === "string" ? v : JSON.stringify(v);
                                          return (
                                              <div key={k} className="contents">
                                                  <dt>{k}</dt>
                                                  <dd title={value}>{value}</dd>
                                              </div>
                                          );
                                      })}
                                  </dl>
                              )}
                              {hasOutput && (
                                  <Lines
                                      lines={textLines(stripAnsi(output!))}
                                      label={t("thread-act-result")}
                                      heading={state === "failed" ? t("thread-act-error") : undefined}
                                      bad={state === "failed"}
                                      copyText={stripAnsi(output!)}
                                  />
                              )}
                          </>
                      )
                    : undefined
            }
        />
    );
});

/**
 * Reasoning: the latest heading or first clause on the row; the full text when opened. The row is closed by default,
 * also while the reasoning streams, so the status line is the live signal. When the person opens it, the text grows
 * in place while it streams.
 */
const ThinkingStep = memo(function ThinkingStep({ text, live }: { text: string; live: boolean }) {
    const t = useT();
    const body = text.trim();
    const line = thinkingStatus(body);
    return (
        <StepRow
            kind="thinking"
            state={live ? "running" : "done"}
            verb={live ? t("thread-act-thinking") : t("thread-act-thought")}
            subject={line ? <span className="act-subject-quiet">{line}</span> : undefined}
            title={line}
            detail={
                body && body !== line
                    ? () => <Markdown className="md md-step act-thinking" text={body} streaming={live} />
                    : undefined
            }
        />
    );
});

/**
 * A question the agent asked. One question: its record as a plain step. Several (a multi-step ask): a row
 * counting them, open while waiting.
 */
const QuestionStep = memo(function QuestionStep({ item }: { item: AskRequestItem }) {
    const t = useT();
    if (item.questions.length < 2) {
        return (
            <li className="act-text">
                <QuestionRecord item={item} />
            </li>
        );
    }
    const waiting = item.status === "in_progress";
    const answered = item.answers?.filter((a) => !a.skipped && (a.selected.length > 0 || !!a.text)).length ?? 0;
    return (
        <StepRow
            kind="question"
            state={waiting ? "running" : "done"}
            verb={waiting ? t(QUESTION_WAITING_LABEL) : t("thread-act-asked")}
            subject={waiting ? undefined : t("thread-act-questions", { count: item.questions.length })}
            meta={waiting ? undefined : t("thread-act-answered-of", { answered, total: item.questions.length })}
            open={waiting}
            detail={() => <QuestionRecord item={item} />}
        />
    );
});

/** Where an approval happened in the run. The decision itself is made in the composer tray. */
const ApprovalStep = memo(function ApprovalStep({ item, live }: { item: ApprovalRequestItem; live: boolean }) {
    const t = useT();
    const answer = useApprovalAnswer(item.id);
    const view = describeApproval(item);
    const subject = view.code.split("\n")[0];
    const waiting = answer === undefined && live;
    return (
        <StepRow
            kind="approval"
            state={waiting ? "running" : "done"}
            verb={
                waiting
                    ? t("thread-act-waiting-approval")
                    : answer === true
                      ? t("thread-act-approved")
                      : answer === false
                        ? t("thread-act-denied")
                        : t("thread-act-not-answered")
            }
            subject={subject}
            mono={view.lang === "bash"}
            title={view.code}
            meta={view.warning ? <span className="text-warning">{view.warning}</span> : undefined}
        />
    );
});

/**
 * The run of consecutive web searches that starts at `idx`, or undefined when an earlier search in the
 * same run draws it. Text, reasoning, approvals and other tool calls end a run; tool outputs do not.
 */
function searchRunAt(items: readonly OutputItem[], idx: number): FunctionCallItem[] | undefined {
    const isSearch = (p: OutputItem) => p.type === "function_call" && callKind(p.name, p.arguments) === "web-search";
    for (let i = idx - 1; i >= 0; i--) {
        const p = items[i]!;
        if (p.type === "function_call_output") continue;
        if (isSearch(p)) return undefined;
        break;
    }
    const run: FunctionCallItem[] = [];
    for (let i = idx; i < items.length; i++) {
        const p = items[i]!;
        if (p.type === "function_call_output") continue;
        if (p.type !== "function_call" || !isSearch(p)) break;
        run.push(p);
    }
    return run;
}

/** Progress of a running MCP tool: a bar when the total is known, else the message and the count. */
function ToolProgressRow({ itemId }: { itemId: string }) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const p = useToolProgress(conversationId, itemId);
    if (!p) return null;
    const known = p.total !== undefined && p.total > 0;
    const max = known ? p.total! : 0;
    const value = known ? Math.min(Math.max(p.progress, 0), max) : 0;
    const text =
        p.message ||
        (known ? t("thread-act-progress-of", { value, max }) : t("thread-act-progress-step", { step: p.progress }));
    return (
        <li className="act-progress" data-step="progress">
            {known ? (
                <div
                    role="progressbar"
                    aria-label={p.message || t("thread-act-tool-progress")}
                    aria-valuemin={0}
                    aria-valuemax={max}
                    aria-valuenow={value}
                    className="act-progress-bar"
                >
                    <span style={{ width: `${(value / max) * 100}%` }} />
                </div>
            ) : null}
            <span className="act-progress-text" role="status">
                {text}
                {known && p.message ? ` (${value} of ${max})` : ""}
            </span>
        </li>
    );
}

/** The steps in run order. */
function Steps({ items, running, id, end }: { items: OutputItem[]; running: boolean; id: string; end?: RunEndItem }) {
    const { openPanel } = useContext(ThreadContext);
    const openSource = useMemo(
        () => (openPanel ? (url: string) => openPanel({ kind: "sources", focus: url }) : undefined),
        [openPanel],
    );
    const outputs = new Map<string, FunctionCallOutputItem>();
    for (const it of items) if (it.type === "function_call_output") outputs.set(it.call_id, it);
    const calls = new Set(items.flatMap((i) => (i.type === "function_call" ? [i.call_id] : [])));
    const asked = askedCalls(items);
    const states = callStates(items, running, end);
    // The newest working-plan update opens; earlier ones in the same group stay closed (activity/todo-step.tsx).
    const latestTodo = items.findLast((i) => i.type === "function_call" && i.name === "todo")?.id;
    return (
        <ol id={id} className="act-steps activity-enter">
            {items.map((it, idx) => {
                switch (it.type) {
                    case "reasoning": {
                        const text = it.content.map((c) => c.text).join("") || it.summary.map((s) => s.text).join("\n");
                        return <ThinkingStep key={it.id} text={text} live={running && it.status === "in_progress"} />;
                    }
                    case "function_call": {
                        // The question record replaces the raw tool step.
                        if (asked.has(it.call_id)) return null;
                        const out = outputs.get(it.call_id);
                        const state = states.get(it.call_id) ?? "running";
                        const kind = callKind(it.name, it.arguments);
                        if (kind === "web-search") {
                            // Consecutive searches are one step, drawn by the first of the run.
                            const run = searchRunAt(items, idx);
                            if (!run) return null;
                            return (
                                <WebSearchStep
                                    key={it.id}
                                    entries={run.map((c) => {
                                        const e = entryOf(c, outputs.get(c.call_id));
                                        const s = states.get(c.call_id);
                                        return s === "stopped" ? { ...e, status: "stopped" as const } : e;
                                    })}
                                    live={running}
                                    onOpenSource={openSource}
                                />
                            );
                        }
                        if (kind === "fetch") {
                            const f = fetchOf(it, out);
                            return (
                                <WebFetchStep
                                    key={it.id}
                                    url={f.url}
                                    title={f.title}
                                    state={state}
                                    onOpenSource={openSource}
                                />
                            );
                        }
                        if (it.name === "todo")
                            return (
                                <TodoStep key={it.id} phases={out?.todos} state={state} latest={it.id === latestTodo} />
                            );
                        // While the arguments stream there are no runs yet: show the step starting.
                        const runs = kind === "subagents" ? subagentRunsOf(it, out) : undefined;
                        if (runs || (kind === "subagents" && running && !out)) {
                            return (
                                <SubagentsStep
                                    key={it.id}
                                    runs={runs ?? []}
                                    live={running}
                                    state={state}
                                    onOpen={
                                        openPanel
                                            ? (agentId) => openPanel(subagentDetail(it.call_id, agentId))
                                            : undefined
                                    }
                                />
                            );
                        }
                        return (
                            <Fragment key={it.id}>
                                <ToolStep
                                    name={it.name}
                                    args={it.arguments}
                                    output={out?.output}
                                    state={state}
                                    facts={out}
                                />
                                {state === "running" && running && <ToolProgressRow itemId={it.id} />}
                            </Fragment>
                        );
                    }
                    case "function_call_output":
                        if (calls.has(it.call_id)) return null;
                        return (
                            <ToolStep
                                key={it.id}
                                name="tool"
                                args=""
                                output={it.output}
                                state={it.is_error ? "failed" : "done"}
                            />
                        );
                    case "mcp_approval_request":
                        return <ApprovalStep key={it.id} item={it} live={running} />;
                    case "chat.ask_request":
                        return <QuestionStep key={it.id} item={it} />;
                    case "chat.mcp_elicitation":
                        return <ElicitationStep key={it.id} item={it as McpElicitationItem} live={running} />;
                    case "message":
                        if (it.role !== "assistant") return null;
                        return (
                            <li key={it.id} className="act-text">
                                <Markdown
                                    className="md md-step"
                                    text={messageText(it)}
                                    streaming={running && it.status === "in_progress" && idx === items.length - 1}
                                />
                            </li>
                        );
                    default:
                        return null;
                }
            })}
        </ol>
    );
}

// The group

/** Keep a toggle under the pointer: stop following the stream, then undo any shift after layout. */
function useStableToggle(open: boolean) {
    const row = useRef<HTMLButtonElement>(null);
    const before = useRef<number | null>(null);
    const mark = () => {
        const el = row.current;
        if (!el) return;
        before.current = el.getBoundingClientRect().top;
        el.closest(".thread-scroll")?.dispatchEvent(new Event("chat:unpin"));
    };
    useLayoutEffect(() => {
        const top = before.current;
        const el = row.current;
        before.current = null;
        if (top === null || !el) return;
        const scroller = el.closest(".thread-scroll");
        const shift = el.getBoundingClientRect().top - top;
        if (scroller && Math.abs(shift) > 0.5) scroller.scrollTop += shift;
    }, [open]);
    return { row, mark };
}

export function WorkedGroup({ turn, items }: { turn: Turn; items: OutputItem[] }) {
    const { onOpenDetails } = useContext(ThreadContext);
    const running = !!turn.live && !turn.live.done;
    // Approval answers change the live label; subscribe so it updates when the tray answers.
    useApprovalVersion();
    // undefined until the user toggles: open while running, closed when done. Once touched it stays put.
    const [manual, setManual] = useState<boolean>();
    const open = manual ?? running;
    const { row, mark } = useStableToggle(open);
    const bodyId = useId();
    const end = endOf(turn.items);
    const ms = turn.live ? turn.live.durationMs : historyDuration(turn);
    const duration = ms !== undefined && ms >= 1000 ? formatDuration(ms) : undefined;
    let failed = 0;
    let stopped = 0;
    for (const s of callStates(items, running, end).values()) {
        if (s === "failed") failed++;
        else if (s === "stopped") stopped++;
    }
    const toggle = () => {
        if (onOpenDetails) return onOpenDetails(turn.key);
        mark();
        setManual(!open);
    };

    let label: ReactNode;
    if (running) {
        label = (
            <>
                <ThinkingIndicator label={liveGroupLabel(items)} className="act-summary-live" />
                {turn.live && (
                    <span className="act-summary-meta">
                        <Elapsed startedAt={turn.live.startedAt} durationMs={0} running />
                    </span>
                )}
            </>
        );
    } else {
        label = (
            <>
                <span className="act-summary-text">{summarise(items)}</span>
                {(failed > 0 || stopped > 0 || duration) && (
                    <span className="act-summary-meta">
                        {failed > 0 && <span className="act-summary-bad">· {failed} failed </span>}
                        {stopped > 0 && <span>· {stopped} stopped </span>}
                        {duration && <span>· {duration}</span>}
                    </span>
                )}
            </>
        );
    }

    return (
        <div className="act-group" data-activity-group="">
            <button
                ref={row}
                type="button"
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={toggle}
                className="act-summary"
            >
                {label}
                <CaretRightIcon size={14} aria-hidden className="act-caret" data-open={open} />
            </button>
            {open && <Steps id={bodyId} items={items} running={running} end={end} />}
        </div>
    );
}

/** A slash command answered by the runtime (`response.local`): one compact row, output collapsed. */
export const LocalNoticeRow = memo(function LocalNoticeRow({
    command,
    output,
    running,
    failed,
}: {
    command?: string;
    output: string;
    running: boolean;
    failed: boolean;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const bodyId = useId();
    const first = output
        .split("\n")
        .find((l) => l.trim())
        ?.trim();
    return (
        <div
            role="note"
            aria-label={t("thread-act-command-output", { command: command ?? t("thread-act-command") })}
            className="act-group"
        >
            <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                disabled={running}
                onClick={() => setOpen(!open)}
                className="act-summary"
            >
                {running ? (
                    <ThinkingIndicator
                        label={t("thread-act-running-named", { name: command ?? t("thread-act-command-lower") })}
                        className="act-summary-live"
                    />
                ) : (
                    <span className="act-summary-text">
                        <span className="act-mono text-text">{command ?? t("thread-act-command-output-default")}</span>
                        {first && <span className="act-summary-meta"> · {first}</span>}
                    </span>
                )}
                {!running && <CaretRightIcon size={14} aria-hidden className="act-caret" data-open={open} />}
            </button>
            {open && (
                <div id={bodyId} className="act-detail activity-enter">
                    <Lines
                        lines={textLines(stripAnsi(output))}
                        label={t("thread-act-output")}
                        heading={failed ? t("thread-act-failed") : undefined}
                        bad={failed}
                        copyText={stripAnsi(output)}
                    />
                </div>
            )}
        </div>
    );
});
