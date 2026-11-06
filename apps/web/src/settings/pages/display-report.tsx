/**
 * Settings > About > Display: what this device reports about its viewport and how the page sits in it
 * (app/viewport-report.ts), as selectable text with a Copy button, so a phone can be read without a debugger.
 */

import { useEffect, useState } from "react";
import { viewportReport } from "../../app/viewport-report";
import { Button, SettingRow, SettingsCard, SettingsSection } from "@pikvm/chat-web/settings";

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
        <SettingsSection
            title="Diagnostics"
            description="For a bug report: what this device says about its screen and how the page sits in it."
        >
            <SettingsCard>
                <SettingRow
                    label="Display report"
                    description="Copy it and send it with the problem."
                    stack
                    control={
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button onClick={measure}>Measure again</Button>
                            <Button
                                variant="primary"
                                disabled={text === ""}
                                onClick={() => void copy(text).then((ok) => setCopied(ok ? "done" : "failed"))}
                            >
                                {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
                            </Button>
                        </div>
                    }
                >
                    <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-secondary select-none">Show the report</summary>
                    <pre
                        className="mt-3 -mx-4 w-[calc(100%+2rem)] overflow-x-auto border-t border-default bg-[color-mix(in_srgb,var(--control-track)_50%,var(--panel))] px-4 py-3 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-secondary select-text"
                        data-testid="display-report"
                    >
                        {text}
                    </pre>
                    </details>
                </SettingRow>
            </SettingsCard>
        </SettingsSection>
    );
}
