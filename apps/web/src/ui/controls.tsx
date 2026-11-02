/**
 * The grouped-list vocabulary the Settings pages share: a titled card of rows, each row a
 * label with a control, value or chevron on the right. Controls are native inputs wearing
 * the console's tokens, so keyboard, screen readers and touch behave without extra code.
 */

import { type ReactNode, useId } from "react";

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
    return (
        <section className="mb-6">
            {title ? <h2 className="group-label">{title}</h2> : null}
            <div className="group-card">{children}</div>
            {footer ? <p className="row-hint mt-2 px-4">{footer}</p> : null}
        </section>
    );
}

interface RowProps {
    label: string;
    hint?: ReactNode;
    /** Id of the control this row labels, so the label is announced with it. */
    labelId?: string;
    children?: ReactNode;
}

export function Row({ label, hint, labelId, children }: RowProps) {
    return (
        <div className="row">
            <div className="row-text">
                <div className="row-label" id={labelId}>
                    {label}
                </div>
                {hint ? <div className="row-hint">{hint}</div> : null}
            </div>
            {children}
        </div>
    );
}

export function Value({ children }: { children: ReactNode }) {
    return <span className="row-value">{children}</span>;
}

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
}

interface SegmentedProps<T extends string> {
    label: string;
    options: ReadonlyArray<SegmentedOption<T>>;
    value: T | undefined;
    onChange: (value: T) => void;
    disabled?: boolean;
}

/** A radio group drawn as a segmented control. Native radios give arrow-key navigation. */
export function Segmented<T extends string>({ label, options, value, onChange, disabled }: SegmentedProps<T>) {
    const name = useId();
    return (
        <div className="segmented" role="radiogroup" aria-label={label}>
            {options.map((option) => (
                <label key={option.value}>
                    <input
                        type="radio"
                        name={name}
                        value={option.value}
                        checked={value === option.value}
                        disabled={disabled ?? false}
                        onChange={() => onChange(option.value)}
                    />
                    {option.label}
                </label>
            ))}
        </div>
    );
}

interface SwitchProps {
    label: string;
    checked: boolean | undefined;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            className="switch"
            aria-label={label}
            aria-checked={checked === true}
            disabled={disabled ?? false}
            onClick={() => onChange(!checked)}
        />
    );
}

/** A failure the user should see, announced when it appears. */
export function InlineError({ children }: { children: ReactNode }) {
    return (
        <p role="alert" className="inline-error">
            {children}
        </p>
    );
}
