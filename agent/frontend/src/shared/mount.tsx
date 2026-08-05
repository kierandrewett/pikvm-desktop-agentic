/**
 * The agent's component library, mounted into the PiKVM console.
 *
 * The console is plain browser script with its own stylesheet; the conversation
 * is React with shadcn and Base UI. Sitting side by side in one window that was
 * two design systems: the same 30x30 round icon button existed twice, one with
 * a rendered tooltip and one with the operating system's, which appears after a
 * second and cannot be styled at all.
 *
 * This is the seam between them. The console keeps owning its state and its
 * behaviour and hands over only what to draw, so nothing about how it talks to
 * the target moves into React.
 *
 * Loading the workspace stylesheet into the console document was measured to
 * change nothing there: Tailwind v4 emits everything inside @layer, and
 * unlayered author CSS beats every layer, so console.css keeps winning wherever
 * it has an opinion and Tailwind only fills the gaps.
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

export type IconButtonSpec = {
    /** Stable identity, so the console can find it again after a re-render. */
    id: string;
    /** Shown in the tooltip and used as the accessible name. */
    label: string;
    /** Inline SVG markup, exactly as the console already has it. */
    icon: string;
    pressed?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    /** Extra classes from the host's own stylesheet.
     *
     *  The console has controls whose LOOK is already expressed in CSS — the
     *  audio pair carry a live level meter drawn with a ::before and a --vol
     *  custom property. Rewriting that in Tailwind to change the button would
     *  be a second copy of a thing that works; the class comes across instead. */
    className?: string;
    onSelect: () => void;
};

function IconButtonRow({ buttons }: { buttons: IconButtonSpec[] }) {
    return (
        <>
            {buttons
                .filter((b) => !b.hidden)
                .map((b) => (
                    <TooltipIconButton
                        key={b.id}
                        tooltip={b.label}
                        aria-label={b.label}
                        aria-pressed={b.pressed}
                        disabled={b.disabled}
                        data-tb={b.id}
                        onClick={b.onSelect}
                        className={`size-[30px] rounded-full p-0${b.className ? " " + b.className : ""}`}
                    >
                        <span
                            aria-hidden="true"
                            className="grid size-[15px] place-items-center [&_svg]:size-[15px]"
                            dangerouslySetInnerHTML={{ __html: b.icon }}
                        />
                    </TooltipIconButton>
                ))}
        </>
    );
}

/**
 * Render a row of icon buttons into a host element.
 *
 * Returns an update function rather than re-mounting: the console repaints these
 * whenever a macro is pinned or the power state changes, and tearing the tree
 * down each time would drop focus and close an open tooltip mid-hover.
 */
export function mountIconButtons(host: HTMLElement, buttons: IconButtonSpec[]) {
    const root: Root = createRoot(host);
    const draw = (next: IconButtonSpec[]) =>
        root.render(
            <StrictMode>
                <IconButtonRow buttons={next} />
            </StrictMode>,
        );
    draw(buttons);
    return { update: draw, unmount: () => root.unmount() };
}

declare global {
    interface Window {
        pikvmShared?: { mountIconButtons: typeof mountIconButtons };
    }
}

window.pikvmShared = { mountIconButtons };
