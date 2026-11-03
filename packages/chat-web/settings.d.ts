/**
 * What the host app sees of the settings kit (`@pikvm/chat-web/settings`, src/settings.ts). The app's TypeScript
 * settings are stricter than the lifted code was written for (`exactOptionalPropertyTypes`), so the app resolves the
 * subpath to this file for type-checking and never checks the kit's internals. `src/test/host-types.ts` checks, under
 * this package's settings, that `src/settings.ts` satisfies it. Only what the host uses is declared.
 */
import type {
    ButtonHTMLAttributes,
    Context,
    HTMLAttributes,
    InputHTMLAttributes,
    ReactElement,
    ReactNode,
} from "react";
import type { Icon } from "@pikvm/icons";

export interface SettingsScopeProps {
    /** False while the tab is hidden behind another. */
    active?: boolean | undefined;
    initialPath?: string | undefined;
    /** Classes for the scope element; defaults to filling its parent. */
    className?: string | undefined;
    children: ReactNode;
}
export function SettingsScope(props: SettingsScopeProps): ReactNode;

export interface Option<T extends string = string> {
    value: T;
    label: string;
    icon?: ReactNode | undefined;
    disabled?: boolean | undefined;
    font?: string | undefined;
}

export type Lock = "file" | "admin" | "policy";
export type Status =
    | { state: "idle" }
    | { state: "saving" }
    | { state: "saved" }
    | { state: "error"; message: string };

export interface PageAction {
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    busy?: boolean | undefined;
    disabled?: boolean | undefined;
    danger?: boolean | undefined;
}

export const SettingsChrome: Context<{ onBack?: (() => void) | undefined }>;

export function SettingsPage(props: {
    title: string;
    description?: ReactNode | undefined;
    sectionNav?: boolean | undefined;
    actions?: (PageAction | false | null | undefined)[] | undefined;
    back?: { label: string; onClick: () => void } | undefined;
    children: ReactNode;
}): ReactNode;

export function SettingsSection(props: {
    title?: ReactNode | undefined;
    description?: ReactNode | undefined;
    action?: ReactNode | undefined;
    id?: string | undefined;
    tone?: "danger" | undefined;
    children: ReactNode;
}): ReactNode;

export function SettingsCard(props: {
    children: ReactNode;
    className?: string | undefined;
    tone?: "danger" | undefined;
    bare?: boolean | undefined;
}): ReactNode;

export function DangerZone(props: {
    title?: string | undefined;
    description?: ReactNode | undefined;
    children: ReactNode;
}): ReactNode;

export function SettingRow(props: {
    id?: string | undefined;
    label: ReactNode;
    description?: ReactNode | undefined;
    hint?: ReactNode | undefined;
    control?: ReactNode | undefined;
    lock?: Lock | null | undefined;
    status?: Status | undefined;
    error?: string | null | undefined;
    reset?: { label?: string | undefined; onReset: () => void } | undefined;
    stack?: boolean | undefined;
    split?: boolean | undefined;
    icon?: ReactNode | undefined;
    children?: ReactNode | undefined;
    className?: string | undefined;
}): ReactNode;

export function LinkRow(props: {
    id?: string | undefined;
    icon?: ReactNode | undefined;
    label: ReactNode;
    description?: ReactNode | undefined;
    trailing?: ReactNode | undefined;
    onClick: () => void;
}): ReactNode;

export function AdvancedSection(props: {
    label?: string | undefined;
    children: ReactNode;
    aside?: ReactNode | undefined;
    defaultOpen?: boolean | undefined;
}): ReactNode;

export function FormField(props: {
    label: string;
    help?: ReactNode | undefined;
    error?: string | null | undefined;
    optional?: boolean | undefined;
    link?: ReactNode | undefined;
    children: (id: string) => ReactNode;
}): ReactNode;

export function Switch(props: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean | undefined;
    label: string;
}): ReactNode;

export function Segmented<T extends string>(props: {
    value: T;
    options: Option<T>[];
    onChange: (value: T) => void;
    disabled?: boolean | undefined;
    label: string;
}): ReactNode;

export function Select<T extends string>(props: {
    value: T;
    options: Option<T>[];
    onChange: (value: T) => void;
    disabled?: boolean | undefined;
    label: string;
    placeholder?: string | undefined;
    leading?: ReactNode | undefined;
    className?: string | undefined;
}): ReactNode;

interface TextFieldBase extends Omit<HTMLAttributes<HTMLInputElement>, "onChange" | "defaultValue"> {
    value: string;
    label?: string | undefined;
    id?: string | undefined;
    size?: "sm" | "md" | undefined;
    mono?: boolean | undefined;
    type?: "text" | "url" | "email" | "password" | "search" | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    required?: boolean | undefined;
    autoComplete?: string | undefined;
    autoFocus?: boolean | undefined;
    maxLength?: number | undefined;
    readOnly?: boolean | undefined;
    invalid?: boolean | undefined;
    className?: string | undefined;
    "data-fk"?: string | undefined;
}
export type TextFieldProps =
    | (TextFieldBase & { onCommit: (value: string) => void; onChange?: undefined })
    | (TextFieldBase & { onChange: (value: string) => void; onCommit?: undefined });
export function TextField(props: TextFieldProps): ReactNode;

export function Input(
    props: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: "sm" | "md" | undefined; mono?: boolean | undefined },
): ReactNode;

export function TextArea(props: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    rows?: number | undefined;
    maxLength?: number | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
}): ReactNode;

export function NumberField(props: {
    value: number | undefined;
    onCommit: (value: number) => void;
    label: string;
    min?: number | undefined;
    max?: number | undefined;
    step?: number | undefined;
    unit?: string | undefined;
    disabled?: boolean | undefined;
    placeholder?: string | undefined;
}): ReactNode;

export function Checkbox(props: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: ReactNode;
    disabled?: boolean | undefined;
}): ReactNode;

/** The class of a text field's box, for a native control that should look like the kit's (a long grouped select). */
export function fieldClass(size: "sm" | "md", mono?: boolean): string;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
    variant?: "primary" | "secondary" | "danger" | "ghost" | undefined;
    size?: "sm" | "md" | undefined;
    busy?: boolean | undefined;
    asChild?: boolean | undefined;
    "data-fk"?: string | undefined;
}
export function Button(props: ButtonProps): ReactNode;
export function IconButton(
    props: ButtonHTMLAttributes<HTMLButtonElement> & { round?: boolean | undefined; "data-fk"?: string | undefined },
): ReactNode;

export function Notice(props: {
    tone?: "neutral" | "warning" | "danger" | "success" | undefined;
    children: ReactNode;
    action?: ReactNode | undefined;
}): ReactNode;

export function EmptyState(props: {
    size?: "row" | "block" | undefined;
    loading?: boolean | undefined;
    icon?: Icon | undefined;
    title?: ReactNode | undefined;
    description?: ReactNode | undefined;
    action?: { label: ReactNode; onClick?: (() => void) | undefined; icon?: Icon | undefined } | ReactNode | undefined;
    className?: string | undefined;
    children?: ReactNode | undefined;
}): ReactNode;

export function Badge(props: {
    tone?: "neutral" | "accent" | "success" | "warning" | "danger" | undefined;
    children: ReactNode;
}): ReactNode;
export function Spinner(props: { className?: string | undefined }): ReactNode;

export interface SettingsNavLinkProps {
    className: string;
    "aria-current"?: "page" | undefined;
    children: ReactNode;
}
export function SettingsNavFrame(props: {
    label: string;
    title: string;
    className?: string | undefined;
    children: ReactNode;
}): ReactNode;
export function SettingsNavSection(props: { id: string; title: string; children: ReactNode }): ReactNode;
export function SettingsNavList(props: { children: ReactNode }): ReactNode;
export function SettingsNavItem(props: {
    icon: Icon;
    label: string;
    active?: boolean | undefined;
    render: (props: SettingsNavLinkProps) => ReactElement;
}): ReactNode;

export function ConfirmDialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    confirmLabel: string;
    danger?: boolean | undefined;
    onConfirm: () => void;
}): ReactNode;
export function Dialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: ReactNode | undefined;
    children?: ReactNode | undefined;
    footer?: ReactNode | undefined;
    width?: number | undefined;
}): ReactNode;
export function Sheet(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title?: string | undefined;
    titleHidden?: boolean | undefined;
    description?: string | undefined;
    className?: string | undefined;
    children: ReactNode;
}): ReactNode;

export interface ToastOptions {
    description?: string | null | undefined;
    id?: string | undefined;
    duration?: number | undefined;
}
export const toast: {
    error(message: string, options?: ToastOptions): string;
    success(message: string, options?: ToastOptions): string;
    info(message: string, options?: ToastOptions): string;
    dismiss(id?: string): void;
};
