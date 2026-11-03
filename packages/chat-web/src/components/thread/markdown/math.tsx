/**
 * TeX math. KaTeX and its stylesheet and fonts load on the first message that contains math (dynamic
 * import, a separate chunk). Until then the TeX source shows in the code font, sized like the result, so
 * the swap barely moves the line. Rendered HTML is cached by (TeX, display), so a re-mounted message paints
 * typeset on its first frame. KaTeX output includes MathML for screen readers; errors render the source in
 * the danger colour instead of throwing.
 */
import { memo, useContext, useEffect, useState } from "react";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../../lib/queries";
import { registerSessionReset } from "../../../lib/session-reset";
import { MdEnv, schedule } from "./env";

type Render = (tex: string, display: boolean) => string;

let renderer: Promise<Render> | undefined;
const cache = new Map<string, string>();
registerSessionReset("markdown-math-cache", () => cache.clear());
const MAX_CACHED = 600;
const key = (tex: string, display: boolean) => `${display ? "D" : "I"}\u0000${tex}`;

function load(): Promise<Render> {
    renderer ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => {
        const katex = m.default;
        return (tex: string, display: boolean) =>
            katex.renderToString(tex, {
                displayMode: display,
                throwOnError: false,
                strict: "ignore",
                trust: false,
                output: "htmlAndMathml",
                maxSize: 50,
                maxExpand: 500,
                errorColor: "var(--danger)",
            });
    });
    return renderer;
}

function useTex(tex: string, display: boolean): string | undefined {
    const env = useContext(MdEnv);
    const [ownerEpoch] = useState(() => env.ownerEpoch ?? captureSessionEpoch());
    const k = key(tex, display);
    const [result, setResult] = useState(() => ({
        tex,
        display,
        html: isSessionEpochCurrent(ownerEpoch) ? cache.get(k) : undefined,
    }));
    useEffect(() => {
        if (!isSessionEpochCurrent(ownerEpoch)) return;
        const hit = cache.get(k);
        if (hit !== undefined) {
            setResult({ tex, display, html: hit });
            return;
        }
        let alive = true;
        void load()
            .then((render) => {
                if (!alive || !isSessionEpochCurrent(ownerEpoch)) return undefined;
                return schedule(() => {
                    // An unmounted block skips typesetting; the queue checks account ownership around the job.
                    if (!alive) return undefined;
                    return render(tex, display);
                }, ownerEpoch);
            })
            .then((outcome) => {
                if (!alive || !isSessionEpochCurrent(ownerEpoch) || outcome?.status !== "completed") return;
                const html = outcome.value;
                if (html === undefined) return;
                // Write only after the queue's post-job check and this continuation's owner check.
                cache.set(k, html);
                if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
                setResult({ tex, display, html });
            })
            .catch(() => {
                if (alive && isSessionEpochCurrent(ownerEpoch)) setResult({ tex, display, html: undefined });
            });
        return () => {
            alive = false;
        };
    }, [k, tex, display, ownerEpoch]);
    return isSessionEpochCurrent(ownerEpoch) && result.tex === tex && result.display === display
        ? result.html
        : undefined;
}

export const MathInline = memo(function MathInline({ tex }: { tex: string }) {
    const html = useTex(tex, false);
    if (html === undefined) return <code className="md-math-src">{tex}</code>;
    return <span className="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
});

export const MathBlock = memo(function MathBlock({ tex }: { tex: string }) {
    const html = useTex(tex, true);
    return (
        <div className="md-math-block" data-no-drawer-gesture="">
            {html === undefined ? (
                <code className="md-math-src">{tex}</code>
            ) : (
                <div dangerouslySetInnerHTML={{ __html: html }} />
            )}
        </div>
    );
});
