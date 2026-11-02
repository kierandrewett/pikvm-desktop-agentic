/**
 * The frame every KVM dialog sits in, and the small controls they share.
 *
 * Desktop and tablets: a centred panel over a dimmed scrim. Phone: a bottom sheet (or, for the
 * big editors, a full-height page) sized by the visual viewport so the soft keyboard never
 * covers its actions, with the safe areas respected and 44px targets.
 *
 * Keys typed in a dialog belong to the dialog. They stop at its root, so neither the KVM
 * forwarder nor a shortcut sees them (failure mode 2), and Escape closes only the top layer
 * (failure mode 1).
 */

import {
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { COMPACT_QUERY, useMediaQuery, useViewportFrame } from "../../app/viewport";
import type { Confirmation } from "./model/health";

const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open layers, bottom to top. Only the top one may pull focus back or answer Escape. */
const layers: HTMLElement[] = [];

const isTop = (el: HTMLElement): boolean => layers[layers.length - 1] === el;

function focusablesIn(root: HTMLElement): HTMLElement[] {
    // Not getClientRects(): it is empty for everything under jsdom, and `hidden` is what hides these controls here.
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.closest("[hidden]") === null && getComputedStyle(el).display !== "none",
    );
}

export type DialogSize = "default" | "wide" | "full";

/**
 * `modal` is a dialog over the app. `page` draws the same panel in place, as the content of a
 * page (Settings): no scrim, no focus trap, no Escape, and the title is the page's own.
 */
export type DialogPresentation = "modal" | "page";

export interface DialogShellProps {
    readonly title: string;
    readonly onClose: () => void;
    readonly children: ReactNode;
    /** Buttons under the content, right-aligned and pinned. */
    readonly actions?: ReactNode;
    /** Buttons pinned at the left of the same row (a secondary action such as Reset). */
    readonly startActions?: ReactNode;
    readonly size?: DialogSize;
    /** Selector of the control to focus first; defaults to the first focusable. */
    readonly initialFocus?: string;
    /** `alertdialog` for a question the user must answer. */
    readonly role?: "dialog" | "alertdialog";
    /** Stacked above another dialog (a confirmation). */
    readonly layer?: "dialog" | "confirm";
    readonly testId?: string;
    readonly presentation?: DialogPresentation;
}

export function DialogShell(props: DialogShellProps) {
    return props.presentation === "page" ? <PageShell {...props} /> : <ModalShell {...props} />;
}

function PageShell({ children, actions, startActions, size = "default", testId }: DialogShellProps) {
    const compact = useMediaQuery(COMPACT_QUERY);
    return (
        <section className="dlg-scrim" data-presentation="page" data-compact={compact} data-testid={testId}>
            <div className="dlg" data-size={size}>
                <div className="dlg-body">{children}</div>
                {actions || startActions ? (
                    <div className="dlg-actions">
                        {startActions ? <div className="dlg-actions-start">{startActions}</div> : null}
                        {actions}
                    </div>
                ) : null}
            </div>
        </section>
    );
}

function ModalShell({
    title,
    onClose,
    children,
    actions,
    startActions,
    size = "default",
    initialFocus,
    role = "dialog",
    layer = "dialog",
    testId,
}: DialogShellProps) {
    const titleId = useId();
    const scrim = useRef<HTMLDivElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const compact = useMediaQuery(COMPACT_QUERY);
    const frame = useViewportFrame();
    // A press that STARTS on the backdrop closes; a drag that ends there (selecting text) does not.
    const pressedBackdrop = useRef(false);

    useEffect(() => {
        const root = scrim.current;
        const body = panel.current;
        if (!root || !body) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        layers.push(root);

        const first = (initialFocus ? body.querySelector<HTMLElement>(initialFocus) : null) ?? focusablesIn(body)[0] ?? body;
        first.focus({ preventScroll: true });

        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                closeRef.current();
                return;
            }
            if (e.key !== "Tab") return;
            const items = focusablesIn(body);
            const head = items[0];
            const tail = items[items.length - 1];
            if (!head || !tail) {
                e.preventDefault();
                return;
            }
            const active = document.activeElement;
            if (e.shiftKey && (active === head || active === body)) {
                e.preventDefault();
                tail.focus();
            } else if (!e.shiftKey && active === tail) {
                e.preventDefault();
                head.focus();
            }
        };
        // React hears a portal's events on document.body, so the dialog's own handlers (Enter in a
        // field, Ctrl+Enter to send) run there first; the key then stops at body, short of the
        // document listeners that forward keys to the target. Listeners on one node run in the
        // order they were added, and React's was added when the portal was created.
        const keep = (e: Event): void => {
            if (e.target instanceof Node && root.contains(e.target)) e.stopPropagation();
        };
        root.addEventListener("keydown", onKey);
        const KEY_EVENTS = ["keydown", "keyup", "keypress", "beforeinput"] as const;
        for (const type of KEY_EVENTS) document.body.addEventListener(type, keep);

        // Focus that wandered out (the hidden keyboard field reclaiming it) is pulled back in.
        const onFocusIn = (e: FocusEvent): void => {
            if (!isTop(root) || (e.target instanceof Node && root.contains(e.target))) return;
            (focusablesIn(body)[0] ?? body).focus({ preventScroll: true });
        };
        document.addEventListener("focusin", onFocusIn);

        return () => {
            document.removeEventListener("focusin", onFocusIn);
            root.removeEventListener("keydown", onKey);
            for (const type of KEY_EVENTS) document.body.removeEventListener(type, keep);
            const at = layers.indexOf(root);
            if (at >= 0) layers.splice(at, 1);
            // Not the hidden keyboard field: handing focus back to it would raise the soft keyboard unasked.
            if (previous && previous.isConnected && !previous.classList.contains("kvm-kbd")) {
                previous.focus({ preventScroll: true });
            }
        };
        // The focus target is chosen once, when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return createPortal(
        <div
            ref={scrim}
            className="dlg-scrim"
            data-kvm-ui=""
            data-layer={layer}
            data-compact={compact}
            data-testid={testId}
            style={{ top: frame.top, height: frame.height }}
            onPointerDown={(e) => {
                pressedBackdrop.current = e.target === e.currentTarget;
            }}
            onPointerUp={(e) => {
                if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
                pressedBackdrop.current = false;
            }}
        >
            <div
                ref={panel}
                className="dlg"
                role={role}
                aria-modal="true"
                aria-labelledby={titleId}
                data-size={size}
                tabIndex={-1}
            >
                <div className="dlg-head">
                    <h2 className="dlg-title" id={titleId}>
                        {title}
                    </h2>
                </div>
                <div className="dlg-body">{children}</div>
                {actions || startActions ? (
                    <div className="dlg-actions">
                        {startActions ? <div className="dlg-actions-start">{startActions}</div> : null}
                        {actions}
                    </div>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}

/* ---- small controls -------------------------------------------------- */

export interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
    readonly variant?: "default" | "primary" | "danger";
}

export function Btn({ variant = "default", className, ...rest }: BtnProps) {
    return <button type="button" className={`dlg-btn${variant === "default" ? "" : ` ${variant}`}${className ? ` ${className}` : ""}`} {...rest} />;
}

export function Note({ children, warn, live }: { children: ReactNode; warn?: boolean; live?: boolean }) {
    return (
        <p className={`dlg-note${warn ? " is-warn" : ""}`} {...(live ? { role: "status", "aria-live": "polite" as const } : {})}>
            {children}
        </p>
    );
}

export function Rule() {
    return <hr className="dlg-hr" />;
}

/* ---- confirmation ---------------------------------------------------- */

export interface ConfirmRequest extends Confirmation {
    /** Styles Confirm as the dangerous choice. */
    readonly danger?: boolean;
}

interface ConfirmLayerProps {
    readonly request: ConfirmRequest;
    readonly busy?: boolean;
    readonly error?: string | null;
    readonly onAnswer: (confirmed: boolean) => void;
}

/**
 * A question above whatever is open. Cancel has the focus, so Enter or a stray double tap on the
 * button that opened this answers "no" (failure mode 6); Confirm is disabled while its request
 * is in flight so a second tap sends nothing (failure mode 7).
 */
export function ConfirmLayer({ request, busy = false, error, onAnswer }: ConfirmLayerProps) {
    return (
        <DialogShell
            title={request.title}
            onClose={() => onAnswer(false)}
            role="alertdialog"
            layer="confirm"
            initialFocus="[data-cancel]"
            testId="confirm-layer"
            actions={
                <>
                    <Btn data-cancel="" onClick={() => onAnswer(false)}>
                        Cancel
                    </Btn>
                    <Btn variant={request.danger ? "danger" : "primary"} disabled={busy} onClick={() => onAnswer(true)}>
                        {request.confirm}
                    </Btn>
                </>
            }
        >
            <p className="dlg-confirm-body">{request.body}</p>
            {error ? (
                <p className="dlg-note is-warn" role="alert">
                    {error}
                </p>
            ) : null}
        </DialogShell>
    );
}

export interface Confirmer {
    /** Resolves true when the user confirms, false when they cancel or press Escape. */
    ask(request: ConfirmRequest): Promise<boolean>;
    /** Render this inside the dialog that asks. */
    readonly element: ReactNode;
}

/** `const confirm = useConfirm(); … if (!(await confirm.ask({...}))) return; … {confirm.element}` */
export function useConfirm(): Confirmer {
    const [pending, setPending] = useState<{ request: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null);
    const resolveRef = useRef<((ok: boolean) => void) | null>(null);

    // A dialog that goes away with a question open answers it "no", so nothing waits forever.
    useEffect(
        () => () => {
            resolveRef.current?.(false);
            resolveRef.current = null;
        },
        [],
    );

    const ask = useCallback(
        (request: ConfirmRequest) =>
            // Executor form on purpose: Promise.withResolvers is iOS 17.4+ and this runs on phones.
            new Promise<boolean>((resolve) => {
                resolveRef.current?.(false);
                resolveRef.current = resolve;
                setPending({ request, resolve });
            }),
        [],
    );

    const element = pending ? (
        <ConfirmLayer
            request={pending.request}
            onAnswer={(ok) => {
                resolveRef.current = null;
                setPending(null);
                pending.resolve(ok);
            }}
        />
    ) : null;

    return { ask, element };
}

/* ---- a text field that commits on blur or Enter ------------------------ */

export interface CommitInputProps {
    readonly value: string;
    readonly onCommit: (value: string) => void;
    readonly label: string;
    readonly type?: "text" | "number";
    readonly className?: string;
    readonly maxLength?: number;
    readonly min?: number;
    readonly max?: number;
    readonly "data-fk"?: string;
}

/**
 * Typing is local; the change is committed when the field is left or Enter is pressed. A save per
 * keystroke would PUT the whole macro list (and re-render the editor) every letter.
 */
export function CommitInput({ value, onCommit, label, type = "text", className = "dlg-text", maxLength, min, max, ...rest }: CommitInputProps) {
    const [local, setLocal] = useState(value);
    const focused = useRef(false);
    // An outside change shows through, but never under the user's fingers.
    useEffect(() => {
        if (!focused.current) setLocal(value);
    }, [value]);
    const commit = (): void => {
        if (local !== value) onCommit(local);
    };
    return (
        <input
            {...rest}
            type={type}
            className={className}
            aria-label={label}
            value={local}
            maxLength={maxLength}
            min={min}
            max={max}
            spellCheck={false}
            autoComplete="off"
            onFocus={() => {
                focused.current = true;
            }}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={() => {
                focused.current = false;
                commit();
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                }
            }}
        />
    );
}
