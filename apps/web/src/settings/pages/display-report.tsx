/**
 * Settings > About > Display: what this device reports about its viewport and how the page sits in it
 * (app/viewport-report.ts), as selectable text with a Copy button, so a phone can be read without a debugger.
 */

import { useEffect, useState } from "react";
import { viewportReport } from "../../app/viewport-report";
import { Group } from "../../ui/controls";

/** Clipboard API where there is one; a throwaway textarea and execCommand where there is not (an insecure origin). */
async function copy(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.append(area);
        area.select();
        try {
            return document.execCommand("copy");
        } catch {
            return false;
        } finally {
            area.remove();
        }
    }
}

export function DisplayReport() {
    const [text, setText] = useState("");
    const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
    const measure = () => {
        setText(viewportReport());
        setCopied("idle");
    };
    useEffect(measure, []);

    return (
        <Group title="Display" footer="What this device reports about its screen and how the page sits in it. Copy it to send.">
            <div className="flex gap-2 px-4 pt-3">
                <button type="button" className="btn" onClick={measure}>
                    Measure again
                </button>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={text === ""}
                    onClick={() => void copy(text).then((ok) => setCopied(ok ? "done" : "failed"))}
                >
                    {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
                </button>
            </div>
            <pre
                className="m-0 overflow-x-auto px-4 py-3 text-[11px] leading-snug whitespace-pre-wrap break-words"
                style={{ userSelect: "text", WebkitUserSelect: "text", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                data-testid="display-report"
            >
                {text}
            </pre>
        </Group>
    );
}
