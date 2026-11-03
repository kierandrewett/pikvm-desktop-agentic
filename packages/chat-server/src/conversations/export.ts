/**
 * Conversation export as Markdown: the active branch of the session file, as the thread shows it, in a file a person
 * can keep or share. Built from the same items as the thread (history.ts), so it needs no agent process.
 *
 * Kept: user messages (with attachment names), assistant text, the steps the assistant took (one line each, with the
 * command, path or query), questions and answers, the working plan, compaction markers and end notes.
 * Left out: reasoning text, raw tool output and gen UI markup beyond its source text. The agent runtime has its own
 * HTML export, but that file carries the runtime's branding and its own viewer, so Chat does not offer it.
 */
import type { ConversationRow } from "./service.ts";
import type { OutputItem, TodoPhase } from "@pikvm/chat-protocol";

const TODO_MARK: Record<string, string> = {
    completed: "[x]",
    in_progress: "[ ] (in progress)",
    pending: "[ ]",
    blocked: "[ ] (blocked)",
    abandoned: "[-]",
};

/** One line for a tool call: its name and the most telling argument. */
function stepLine(name: string, args: string): string {
    let a: Record<string, unknown> = {};
    try {
        a = JSON.parse(args || "{}") as Record<string, unknown>;
    } catch {}
    const pick = ["command", "cmd", "path", "file_path", "query", "pattern", "url"].map((k) => a[k]);
    const detail = pick.find((v): v is string => typeof v === "string" && v.trim() !== "");
    const short = detail ? ` \`${detail.split("\n")[0]!.slice(0, 160).replaceAll("`", "'")}\`` : "";
    return `- ${name}${short}`;
}

function todoLines(phases: readonly TodoPhase[]): string[] {
    const out: string[] = [];
    for (const p of phases) {
        if (phases.length > 1) out.push(`- ${p.name}`);
        for (const t of p.tasks)
            out.push(`${phases.length > 1 ? "  " : ""}- ${TODO_MARK[t.status] ?? "[ ]"} ${t.content}`);
    }
    return out;
}

/** A Markdown document for one conversation. `items` are the whole active branch, oldest first. */
export function conversationMarkdown(row: ConversationRow, items: readonly OutputItem[]): string {
    const lines: string[] = [`# ${row.title || "Untitled chat"}`, ""];
    const meta = [row.model && `Model: ${row.model}`, `Exported: ${new Date().toISOString()}`].filter(Boolean);
    lines.push(`_${meta.join(" · ")}_`, "");
    let steps: string[] = [];
    const flush = () => {
        if (!steps.length) return;
        lines.push("<details><summary>Steps</summary>", "", ...steps, "", "</details>", "");
        steps = [];
    };
    for (const it of items) {
        switch (it.type) {
            case "message": {
                flush();
                const text = it.content
                    .map((c) =>
                        c.type === "input_text" || c.type === "output_text"
                            ? c.text
                            : c.type === "input_file"
                              ? `[file: ${c.filename}]`
                              : c.type === "input_image"
                                ? "[image]"
                                : "",
                    )
                    .filter(Boolean)
                    .join("\n\n");
                if (!text.trim()) break;
                lines.push(it.role === "user" ? "## You" : "## Assistant", "", text.trim(), "");
                break;
            }
            case "function_call":
                if (it.name !== "todo" && it.name !== "ask") steps.push(stepLine(it.name, it.arguments));
                break;
            case "function_call_output":
                if (it.todos?.length) {
                    flush();
                    lines.push("**Plan**", "", ...todoLines(it.todos), "");
                }
                break;
            case "chat.ask_request": {
                flush();
                for (const q of it.questions) {
                    const a = it.answers?.find((x) => x.id === q.id);
                    const answer =
                        a && !a.skipped ? [...a.selected, ...(a.text ? [a.text] : [])].join(", ") : "(no answer)";
                    lines.push(`> **Question:** ${q.question}`, `> **Answer:** ${answer}`, "");
                }
                break;
            }
            case "chat.compaction":
                flush();
                lines.push("_Earlier messages were summarised here._", "");
                break;
            case "chat.run_end":
                flush();
                lines.push(`_${it.message}_`, "");
                break;
        }
    }
    flush();
    return `${lines.join("\n").trimEnd()}\n`;
}

/** A safe download name from the chat title. */
export function exportFileName(row: ConversationRow): string {
    const base = (row.title || "chat")
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);
    return `${base || "chat"}.md`;
}
