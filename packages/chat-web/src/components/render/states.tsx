/**
 * Shared states for every renderer: loading skeletons shaped like the content, error with retry,
 * too large to preview, and empty file. All of them centre in the renderer's box and offer the
 * download, so a preview never becomes a dead end.
 */
import {
    BracketsCurly,
    DownloadSimple,
    File,
    FileAudio,
    FileCode,
    FileCsv,
    FileDashed,
    FileDoc,
    FileHtml,
    FileImage,
    FileMd,
    FilePdf,
    FileSvg,
    FileVideo,
    FileZip,
    Sparkle,
    type Icon,
} from "@pikvm/icons";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../l10n/provider";
import { Button } from "../ui/button";
import { ErrorState as PanelErrorState } from "../ui/state";
import { formatBytes, kindLabel } from "./detect";
import type { Load } from "./hooks";
import { RenderError } from "./resource";
import { useHost } from "./toolbar";
import type { RenderKind } from "./types";

export const KIND_ICON: Record<RenderKind, Icon> = {
    pdf: FilePdf,
    sheet: FileCsv,
    markdown: FileMd,
    docx: FileDoc,
    code: FileCode,
    json: BracketsCurly,
    image: FileImage,
    svg: FileSvg,
    audio: FileAudio,
    video: FileVideo,
    html: FileHtml,
    openui: Sparkle,
    archive: FileZip,
    binary: File,
};

export function DownloadButton({ solid, label }: { solid?: boolean; label?: string }) {
    const t = useT();
    const { downloadUrl, name } = useHost();
    if (!downloadUrl) return null;
    return (
        <Button asChild variant={solid ? "solid" : "soft"} size="xl" pill className="text-base">
            <a href={downloadUrl} download={name}>
                <DownloadSimple /> {label ?? t("render-download")}
            </a>
        </Button>
    );
}

export function StateCard({
    icon,
    tone = "neutral",
    title,
    body,
    actions,
    children,
}: {
    icon: ReactNode;
    tone?: "neutral" | "danger";
    title: string;
    body?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
            <div className="flex w-full max-w-96 flex-col items-center text-center">
                <div
                    className={cn(
                        "mb-4 flex size-14 items-center justify-center rounded-2xl",
                        tone === "danger" ? "bg-danger-bg text-danger" : "bg-soft text-secondary",
                    )}
                >
                    {icon}
                </div>
                <div className="max-w-full text-md font-medium text-balance break-words text-text">{title}</div>
                {body && <div className="mt-1 text-sm text-pretty text-secondary">{body}</div>}
                {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
                {children}
            </div>
        </div>
    );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    const t = useT();
    const { kind, name } = useHost();
    if (error instanceof RenderError && error.code === "too-large") return <TooLargeState size={error.size} />;
    const message =
        error instanceof RenderError ? error.message : t("render-error-unreadable", { kind: kindLabel(kind, name) });
    const gone = error instanceof RenderError && (error.code === "not-found" || error.code === "forbidden");
    return (
        <div className="flex min-h-0 flex-1 overflow-auto">
            <PanelErrorState
                size="panel"
                placement="optical"
                title={t("render-error-title", { name })}
                description={message}
                error={error}
                onRetry={gone ? undefined : onRetry}
                secondaryAction={gone ? undefined : <DownloadButton />}
            />
        </div>
    );
}

export function TooLargeState({ size }: { size?: number }) {
    const t = useT();
    const { kind, name } = useHost();
    const Glyph = KIND_ICON[kind];
    return (
        <StateCard
            icon={<Glyph size={28} />}
            title={t("render-too-large-title")}
            body={size ? t("render-too-large-body-size", { size: formatBytes(size) }) : t("render-too-large-body")}
            actions={<DownloadButton solid />}
        />
    );
}

export function EmptyState() {
    const t = useT();
    const { name } = useHost();
    return (
        <StateCard
            icon={<FileDashed size={28} />}
            title={t("render-empty-title")}
            body={t("render-empty-body", { name })}
        />
    );
}

/**
 * Skeleton in the shape of the content. It appears after a short delay so fast loads never flash,
 * and it does not shimmer: a preview surface stays calm while it waits.
 */
export function Skeleton({ kind }: { kind: RenderKind }) {
    const t = useT();
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setShown(true), 120);
        return () => clearTimeout(t);
    }, []);
    return (
        <div
            role="status"
            aria-label={t("render-loading")}
            aria-busy="true"
            className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-200",
                shown ? "opacity-100" : "opacity-0",
            )}
        >
            {kind === "pdf" || kind === "docx" ? (
                <PagesSkeleton />
            ) : kind === "sheet" ? (
                <GridSkeleton />
            ) : kind === "markdown" || kind === "html" ? (
                <ProseSkeleton />
            ) : kind === "image" || kind === "svg" || kind === "video" ? (
                <div className="rv-canvas flex flex-1 items-center justify-center p-8">
                    <div className="aspect-[4/3] w-full max-w-[min(560px,80%)] rounded-md bg-soft" />
                </div>
            ) : kind === "audio" || kind === "archive" || kind === "binary" ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="flex w-full max-w-96 flex-col items-center gap-3">
                        <div className="size-14 rounded-2xl bg-soft" />
                        <div className="h-3 w-48 rounded-xs bg-soft" />
                        <div className="h-2.5 w-32 rounded-xs bg-soft" />
                    </div>
                </div>
            ) : (
                <CodeSkeleton />
            )}
        </div>
    );
}

const CODE_WIDTHS = [62, 48, 0, 74, 55, 81, 40, 0, 66, 52, 30, 58, 0, 70, 44];

function CodeSkeleton() {
    return (
        <div className="flex flex-col py-3">
            {CODE_WIDTHS.map((w, i) => (
                <div key={i} className="flex h-5 items-center">
                    <span className="flex h-full w-12 shrink-0 items-center justify-end border-e border-default pe-3">
                        <span className="h-2 w-3 rounded-xs bg-soft" />
                    </span>
                    {w > 0 && <span className="ms-4 h-2.5 rounded-xs bg-soft" style={{ width: `${w}%` }} />}
                </div>
            ))}
        </div>
    );
}

function ProseSkeleton() {
    const lines = [92, 100, 96, 64, 0, 100, 88, 97, 40, 0, 100, 94, 72];
    return (
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-6 py-8">
            <div className="mb-3 h-5 w-2/5 rounded-xs bg-soft" />
            {lines.map((w, i) =>
                w ? (
                    <div key={i} className="h-3 rounded-xs bg-soft" style={{ width: `${w}%` }} />
                ) : (
                    <div key={i} className="h-2" />
                ),
            )}
        </div>
    );
}

function PagesSkeleton() {
    return (
        <div className="rv-canvas flex flex-1 flex-col items-center gap-4 overflow-hidden p-6">
            {[0, 1].map((i) => (
                <div key={i} className="rv-page aspect-[1/1.294] w-full max-w-[640px] shrink-0 opacity-60" />
            ))}
        </div>
    );
}

function GridSkeleton() {
    const cols = [18, 26, 14, 22, 20];
    return (
        <div className="flex flex-col">
            <div className="flex h-9 items-center gap-6 border-b border-default bg-surface ps-14 pe-4">
                {cols.map((w, i) => (
                    <span key={i} className="h-2.5 rounded-xs bg-soft" style={{ width: `${w}%` }} />
                ))}
            </div>
            {Array.from({ length: 14 }, (_, r) => (
                <div key={r} className="flex h-8 items-center gap-6 border-b border-subtle pe-4">
                    <span className="flex h-full w-10 shrink-0 items-center justify-end border-e border-default pe-2">
                        <span className="h-2 w-3 rounded-xs bg-soft" />
                    </span>
                    {cols.map((w, i) => (
                        <span
                            key={i}
                            className="h-2 rounded-xs bg-soft opacity-70"
                            style={{ width: `${w * (0.6 + ((r * 7 + i * 3) % 5) / 10)}%` }}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

/** Render the shared state for a load that is not ready yet; null when it is ready. */
export function pendingState<T>(load: Load<T>, kind: RenderKind): ReactNode | null {
    if (load.status === "loading") return <Skeleton kind={kind} />;
    if (load.status === "error") return <ErrorState error={load.error} onRetry={load.retry} />;
    return null;
}
