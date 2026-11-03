/**
 * Wrap and Copy: the one pair of controls for any view of source text. File renderers put them in their
 * toolbar (code, Markdown source, raw JSON, HTML source); chat code blocks put them in their header inside a
 * `ToolScope`. Kept out of the renderer chunks so a chat message can use them without loading a renderer.
 */
import { ArrowUDownLeft, Check, Copy } from "@pikvm/icons";
import { useT } from "../../l10n/provider";
import { useCopied } from "./hooks";
import { ToolButton } from "./toolbar";

export function TextTools({
    text,
    wrap,
    onWrap,
    className,
}: {
    text: string;
    wrap: boolean;
    onWrap: (v: boolean) => void;
    /** Extra classes for both buttons (a code block's header uses the text colour). */
    className?: string;
}) {
    const t = useT();
    const [copied, copy] = useCopied();
    return (
        <>
            <ToolButton
                label={wrap ? t("render-wrap-off") : t("render-wrap-on")}
                pressed={wrap}
                onClick={() => onWrap(!wrap)}
                className={className}
            >
                <ArrowUDownLeft weight={wrap ? "fill" : "regular"} />
            </ToolButton>
            <ToolButton
                label={copied ? t("render-copied") : t("render-copy-contents")}
                onClick={() => copy(text)}
                className={className}
            >
                {copied ? <Check /> : <Copy />}
            </ToolButton>
        </>
    );
}
