/**
 * Phone "+" sheet: what the desktop "+" menu offers, as a bottom sheet with 52px rows. Photos, camera and files
 * open the system pickers; "Write in full screen" opens the full-screen editor; each MCP server adds an @mention
 * at the caret. The desktop composer keeps its inline "+" menu.
 */
import { ArrowsOutSimple, Camera, Images, Paperclip, Plugs } from "@pikvm/icons";
import type { ReactNode } from "react";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { Sheet } from "../ui/sheet";
import type { McpServer } from "./suggest";

function SheetRow({
    icon,
    title,
    description,
    problem = false,
    onClick,
}: {
    icon: ReactNode;
    title: string;
    description?: string;
    problem?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex min-h-13 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-text outline-none active:bg-hover focus-visible:bg-hover"
        >
            <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-soft [&_svg]:size-5"
            >
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-md leading-6">{title}</span>
                {description && (
                    <span
                        className={cn(
                            "block truncate text-sm leading-[18px]",
                            problem ? "text-danger" : "text-tertiary",
                        )}
                    >
                        {description}
                    </span>
                )}
            </span>
        </button>
    );
}

export function AttachSheet({
    open,
    onOpenChange,
    servers,
    onPhotos,
    onCamera,
    onFiles,
    onFullscreen,
    onServer,
    attachments = true,
    fullscreen = true,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    servers: McpServer[];
    attachments?: boolean;
    fullscreen?: boolean;
    onPhotos: () => void;
    onCamera: () => void;
    onFiles: () => void;
    onFullscreen: () => void;
    onServer: (server: McpServer) => void;
}) {
    const t = useT();
    // Close first, then act: a system picker opened under a closing sheet keeps the sheet's focus trap.
    const run = (fn: () => void) => () => {
        onOpenChange(false);
        requestAnimationFrame(fn);
    };
    return (
        <Sheet open={open} onOpenChange={onOpenChange} title={t("composer-add-sheet-title")}>
            <div className="flex flex-col pb-2">
                {attachments && (
                    <>
                        <SheetRow
                            icon={<Images />}
                            title={t("composer-add-photos")}
                            description={t("composer-add-photos-description")}
                            onClick={run(onPhotos)}
                        />
                        <SheetRow
                            icon={<Camera />}
                            title={t("composer-add-camera")}
                            description={t("composer-add-camera-description")}
                            onClick={run(onCamera)}
                        />
                        <SheetRow
                            icon={<Paperclip />}
                            title={t("composer-add-files")}
                            description={t("composer-upload-from-device")}
                            onClick={run(onFiles)}
                        />
                    </>
                )}
                {fullscreen && (
                    <SheetRow
                        icon={<ArrowsOutSimple />}
                        title={t("composer-add-fullscreen")}
                        description={t("composer-add-fullscreen-description")}
                        onClick={run(onFullscreen)}
                    />
                )}
                {servers.length > 0 && (
                    <div role="group" aria-label={t("composer-mention-tool")} className="mt-1 flex flex-col">
                        <div className="px-3 pt-2 pb-1 text-sm text-tertiary">{t("composer-mention-tool")}</div>
                        {servers.map((s) => (
                            <SheetRow
                                key={s.name}
                                icon={<Plugs />}
                                title={s.name}
                                description={
                                    s.connected
                                        ? t("composer-server-tools", { count: s.tools.length })
                                        : s.error
                                          ? t("composer-server-not-connected-error", { error: s.error })
                                          : t("composer-server-not-connected")
                                }
                                problem={!s.connected}
                                onClick={run(() => onServer(s))}
                            />
                        ))}
                    </div>
                )}
            </div>
        </Sheet>
    );
}
