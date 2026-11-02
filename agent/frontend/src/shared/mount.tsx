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
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { Button, TooltipIconButton } from "@pikvm/chat-ui/ui";

export type IconButtonSpec = {
    /** Stable identity, so the console can find it again after a re-render. */
    id: string;
    /** Shown in the tooltip and used as the accessible name. */
    label: string;
    /** Inline SVG markup, exactly as the console already has it. */
    icon: string;
    pressed?: boolean;
    /** This button opens a menu.
     *
     *  The console's titlebar has three that do — More actions, the send-keys
     *  list and ATX power — and on the desktop they open a NATIVE menu through
     *  the main process, so there is no element to point aria-controls at and
     *  no open state this side to report. aria-haspopup is the part that can
     *  still be said truthfully: activating this opens a menu rather than doing
     *  something. Without it all three announced as plain buttons. */
    haspopup?: boolean;
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
                        {...(b.haspopup ? { "aria-haspopup": "menu" as const } : {})}
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
    /* flushSync, not a bare render.
     *
     * React schedules a render; it does not perform one. The console rebuilds
     * these rows and then, in the same tick, looks the new controls up by
     * attribute to put focus back where it was — so a scheduled render leaves it
     * searching a DOM that has not been written yet, and focus quietly lands on
     * the body instead. That matters most where a person is pressing several
     * buttons in a row, which is exactly the case the restoration exists for.
     *
     * These are rows of a dozen buttons at most, so the cost of rendering
     * synchronously is not worth measuring against a control that silently
     * stops working. */
    const draw = (next: IconButtonSpec[]) =>
        flushSync(() =>
            root.render(
                <StrictMode>
                    <IconButtonRow buttons={next} />
                </StrictMode>,
            ),
        );
    draw(buttons);
    return { update: draw, unmount: () => root.unmount() };
}

declare global {
    interface Window {
        pikvmShared?: {
            mountIconButtons: typeof mountIconButtons;
            mountButtons: typeof mountButtons;
        };
    }
}

window.pikvmShared = { mountIconButtons, mountButtons };

export type TextButtonSpec = {
    id: string;
    label: string;
    /** Accessible name, when the visible label is not one.
     *
     *  A reorder control reading "↑" is a glyph, not a name — the button has to
     *  say "Move step up" to anything that cannot see the arrow. */
    ariaLabel?: string;
    /** Maps to the library's own variants; the host says intent, not colour. */
    variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
    disabled?: boolean;
    hidden?: boolean;
    className?: string;
    /** Names the control by pointing at existing text, rather than repeating it.
     *
     *  A GPIO row already shows its channel name beside the switch; duplicating
     *  that into an aria-label means the two can drift apart. */
    ariaLabelledBy?: string;
    /** Renders as a switch: the label is the STATE, not the action.
     *
     *  A plain button says what it will do; a switch says what is currently
     *  true and carries `checked` for anything that cannot see the fill. */
    role?: "switch";
    checked?: boolean;
    onSelect: () => void;
};

function TextButtonRow({ buttons }: { buttons: TextButtonSpec[] }) {
    return (
        <>
            {buttons
                .filter((b) => !b.hidden)
                .map((b) => (
                    <Button
                        key={b.id}
                        variant={b.variant ?? "outline"}
                        disabled={b.disabled}
                        data-tb={b.id}
                        onClick={b.onSelect}
                        {...(b.ariaLabel ? { "aria-label": b.ariaLabel } : {})}
                        {...(b.ariaLabelledBy ? { "aria-labelledby": b.ariaLabelledBy } : {})}
                        {...(b.role ? { role: b.role, "aria-checked": b.checked ? "true" : "false" } : {})}
                        {...(b.className ? { className: b.className } : {})}
                    >
                        {b.label}
                    </Button>
                ))}
        </>
    );
}

/**
 * Render a row of labelled buttons into a host element.
 *
 * The same contract as mountIconButtons: an update function rather than a
 * remount, because a dialog repaints on every edit and tearing the tree down
 * each time would drop focus mid-interaction.
 */
export function mountButtons(host: HTMLElement, buttons: TextButtonSpec[]) {
    const root: Root = createRoot(host);
    // Synchronous for the same reason as the icon row above.
    const draw = (next: TextButtonSpec[]) =>
        flushSync(() =>
            root.render(
                <StrictMode>
                    <TextButtonRow buttons={next} />
                </StrictMode>,
            ),
        );
    draw(buttons);
    return { update: draw, unmount: () => root.unmount() };
}
