import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { InlineError } from "../../ui/controls";
import {
    type Attempt,
    type CliStatus,
    HarnessError,
    cancelSignIn,
    isActive,
    signOut,
    startSignIn,
    submitSignInCode,
} from "./harness-api";
import { ConfirmBar, CopyButton, OpenLink, SecretField, formatWhen, isWebUrl, messageOf } from "./parts";
import { harnessKeys, useCliAttempt } from "./queries";

type Confirming = "replace" | "sign-out" | null;

const summary = (status: CliStatus): { tone: "ok" | "warn" | "danger" | "idle"; text: string } => {
    if (!status.installed) return { tone: "warn", text: "Not installed on the machine running the harness" };
    if (status.signed_in === true) {
        const detail = [status.account, status.method].filter((part): part is string => !!part).join(" · ");
        return { tone: "ok", text: detail ? `Signed in · ${detail}` : "Signed in" };
    }
    if (status.signed_in === false) return { tone: "warn", text: "Not signed in" };
    return { tone: "idle", text: status.error ? `Status unavailable: ${status.error}` : "Status unavailable" };
};

/** One CLI: its state, and the sign-in flow when it can be driven from a browser. */
export function CliRow({ status }: { status: CliStatus }) {
    const queryClient = useQueryClient();
    const [started, setStarted] = useState(false);
    const [confirming, setConfirming] = useState<Confirming>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const attemptQuery = useCliAttempt(status.cli, started || isActive(status.attempt));
    const attempt: Attempt | null = attemptQuery.data ?? status.attempt;
    const active = isActive(attempt);
    // An old finished attempt is not news on reload; one the user started here is.
    const showAttempt = attempt !== null && (active || started);

    // When the CLI finishes, what it now says about the account is the news.
    const wasActive = useRef(active);
    useEffect(() => {
        if (wasActive.current && !active) void queryClient.invalidateQueries({ queryKey: harnessKeys.cli });
        wasActive.current = active;
    }, [active, queryClient]);

    const info = summary(status);
    const canSignIn = status.installed && status.browser_sign_in;

    const begin = async (replace: boolean) => {
        setBusy(true);
        setError(null);
        setConfirming(null);
        try {
            const next = await startSignIn(status.cli, replace);
            queryClient.setQueryData(harnessKeys.attempt(status.cli), next);
            setStarted(true);
        } catch (failure) {
            if (failure instanceof HarnessError && failure.code === "already_signed_in") setConfirming("replace");
            else setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const cancel = async () => {
        setBusy(true);
        try {
            queryClient.setQueryData(harnessKeys.attempt(status.cli), await cancelSignIn(status.cli));
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const leave = async () => {
        setBusy(true);
        setError(null);
        try {
            const next = await signOut(status.cli);
            queryClient.setQueryData<CliStatus[]>(harnessKeys.cli, (previous) =>
                previous?.map((item) => (item.cli === next.cli ? next : item)),
            );
            setConfirming(null);
            setStarted(false);
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const submitCode = async (code: string) => {
        setBusy(true);
        setError(null);
        try {
            queryClient.setQueryData(harnessKeys.attempt(status.cli), await submitSignInCode(status.cli, code));
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const dismiss = () => {
        setStarted(false);
        queryClient.removeQueries({ queryKey: harnessKeys.attempt(status.cli) });
    };

    return (
        <div className="px-4 py-3" data-testid={`cli-${status.cli}`}>
            <div className="flex items-start gap-3">
                <div className="row-text">
                    <div className="row-label">{status.label}</div>
                    <div className="row-hint">
                        <span className="status-dot" data-tone={info.tone === "idle" ? undefined : info.tone} aria-hidden="true" />
                        <span role="status">{info.text}</span>
                    </div>
                </div>
                {!active ? (
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                        {canSignIn ? (
                            <button
                                type="button"
                                className={status.signed_in === true ? "btn" : "btn btn-primary"}
                                disabled={busy}
                                aria-label={`${status.signed_in === true ? "Sign in again to" : "Sign in to"} ${status.label}`}
                                onClick={() => (status.signed_in === true ? setConfirming("replace") : void begin(false))}
                            >
                                {status.signed_in === true ? "Sign in again" : "Sign in"}
                            </button>
                        ) : null}
                        {status.installed && status.can_sign_out && status.signed_in === true ? (
                            <button
                                type="button"
                                className="btn"
                                style={{ color: "var(--danger)" }}
                                disabled={busy}
                                aria-label={`Sign out of ${status.label}`}
                                onClick={() => setConfirming("sign-out")}
                            >
                                Sign out
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {!status.browser_sign_in ? <DesktopOnly status={status} /> : null}

            {confirming === "replace" ? (
                <ConfirmBar
                    busy={busy}
                    message={`Signing in again replaces the current ${status.label} login, and cancelling part-way can leave it signed out.`}
                    confirmLabel="Sign in again"
                    onConfirm={() => void begin(true)}
                    onCancel={() => setConfirming(null)}
                />
            ) : null}
            {confirming === "sign-out" ? (
                <ConfirmBar
                    danger
                    busy={busy}
                    message={`Sign out of ${status.label}? The harness cannot use it until you sign in again.`}
                    confirmLabel="Sign out"
                    onConfirm={() => void leave()}
                    onCancel={() => setConfirming(null)}
                />
            ) : null}

            {showAttempt ? (
                <AttemptPanel
                    attempt={attempt}
                    label={status.label}
                    busy={busy}
                    onCancel={() => void cancel()}
                    onSubmitCode={submitCode}
                    onDismiss={dismiss}
                    onRetry={() => void begin(status.signed_in === true)}
                />
            ) : null}

            {error ? (
                <div className="mt-2">
                    <InlineError>{error}</InlineError>
                </div>
            ) : null}
        </div>
    );
}

function DesktopOnly({ status }: { status: CliStatus }) {
    return (
        <div className="mt-3 rounded-[var(--radius-field)] bg-secondary p-3">
            <p className="row-hint m-0">{status.manual_hint ?? `${status.label} can only be signed in on the desktop.`}</p>
            {status.manual_command ? (
                <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-text overflow-x-auto whitespace-nowrap rounded-[var(--radius-control)] bg-card px-2 py-1.5 text-[13px]">
                        {status.manual_command}
                    </code>
                    <CopyButton text={status.manual_command} label={`Copy the ${status.label} sign-in command`} />
                </div>
            ) : null}
        </div>
    );
}

interface AttemptPanelProps {
    attempt: Attempt;
    label: string;
    busy: boolean;
    onCancel: () => void;
    onSubmitCode: (code: string) => Promise<void>;
    onDismiss: () => void;
    onRetry: () => void;
}

function AttemptPanel({ attempt, label, busy, onCancel, onSubmitCode, onDismiss, onRetry }: AttemptPanelProps) {
    const [code, setCode] = useState("");
    const url = attempt.verification_url;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || code.trim() === "") return;
        const value = code;
        setCode("");
        await onSubmitCode(value);
    };

    if (attempt.state === "succeeded") {
        return (
            <Panel>
                <p className="m-0 text-sm" role="status">
                    Signed in to {label}.
                </p>
                <button type="button" className="btn mt-2" onClick={onDismiss}>
                    Done
                </button>
            </Panel>
        );
    }

    if (attempt.state === "failed" || attempt.state === "expired" || attempt.state === "cancelled") {
        const text =
            attempt.state === "cancelled"
                ? "Sign-in cancelled."
                : (attempt.message ?? (attempt.state === "expired" ? "The sign-in expired." : "The sign-in did not complete."));
        return (
            <Panel>
                <InlineError>{text}</InlineError>
                <div className="mt-2 flex gap-2">
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}>
                        Try again
                    </button>
                    <button type="button" className="btn" onClick={onDismiss}>
                        Dismiss
                    </button>
                </div>
            </Panel>
        );
    }

    const expires = formatWhen(attempt.expires_at);
    const waitingForCode = attempt.method === "device_code" && attempt.user_code === null;

    return (
        <Panel>
            {attempt.state === "starting" || url === null || waitingForCode ? (
                <p className="row-hint m-0" role="status">
                    Starting {label} sign-in…
                </p>
            ) : (
                <ol className="m-0 flex list-none flex-col gap-3 p-0">
                    <li>
                        <div className="row-hint mb-1">
                            {attempt.method === "device_code" ? "Open this page on any device and sign in" : "Open this page and sign in"}
                        </div>
                        <div className="flex items-center gap-2">
                            <code
                                className="min-w-0 flex-1 select-text overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-control)] bg-card px-2 py-1.5 text-[13px]"
                                title={isWebUrl(url) ? url : undefined}
                            >
                                {url}
                            </code>
                            <OpenLink url={url} label={`Open the ${label} sign-in page`} />
                            <CopyButton text={url} label={`Copy the ${label} sign-in link`} />
                        </div>
                    </li>
                    {attempt.user_code ? (
                        <li>
                            <div className="row-hint mb-1">Enter this code</div>
                            <div className="flex items-center gap-2">
                                <code
                                    className="select-text rounded-[var(--radius-control)] bg-card px-3 py-1.5 text-lg font-semibold tracking-widest"
                                    data-testid="user-code"
                                >
                                    {attempt.user_code}
                                </code>
                                <CopyButton text={attempt.user_code} label={`Copy the ${label} one-time code`} />
                            </div>
                        </li>
                    ) : null}
                    {attempt.expects_code ? (
                        <li>
                            <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
                                <SecretField label="Code from the sign-in page" value={code} onChange={setCode} placeholder="Paste the code the page shows" disabled={busy} />
                                <button type="submit" className="btn btn-primary" disabled={busy || code.trim() === ""}>
                                    Submit code
                                </button>
                            </form>
                            {attempt.message ? (
                                <div className="mt-2">
                                    <InlineError>{attempt.message}</InlineError>
                                </div>
                            ) : null}
                        </li>
                    ) : null}
                </ol>
            )}
            <div className="mt-3 flex items-center gap-3">
                <button type="button" className="btn" disabled={busy} onClick={onCancel}>
                    Cancel sign-in
                </button>
                {expires && attempt.state === "awaiting_user" ? <span className="row-hint">Waiting until {expires}</span> : null}
            </div>
        </Panel>
    );
}

function Panel({ children }: { children: ReactNode }) {
    return (
        <div className="mt-3 rounded-[var(--radius-field)] bg-secondary p-3" data-testid="sign-in-panel">
            {children}
        </div>
    );
}
