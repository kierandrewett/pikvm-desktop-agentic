/**
 * Runtime notices of a response (`chat.notice`): a retry, a compaction, a warning the runtime raised while it
 * worked. They show as quiet lines under the turn. Warnings and errors use the danger tone; information stays
 * tertiary. Live notices are announced to screen readers (role "status", or "alert" for an error).
 */
import { Info, Warning } from "@pikvm/icons";
import { memo } from "react";
import type { LiveNotice } from "../../lib/live";
import { cn } from "../../lib/cn";

export const RuntimeNotices = memo(function RuntimeNotices({ notices }: { notices: readonly LiveNotice[] }) {
    if (notices.length === 0) return null;
    return (
        <div data-runtime-notices className="mt-3 flex flex-col gap-1">
            {notices.map((n) => {
                const Icon = n.level === "info" ? Info : Warning;
                return (
                    <div
                        key={`${n.level}:${n.message}`}
                        role={n.level === "error" ? "alert" : "status"}
                        data-notice={n.level}
                        className={cn(
                            "flex items-start gap-1.5 text-[14px] leading-5",
                            n.level === "info" ? "text-tertiary" : "text-danger",
                        )}
                    >
                        <Icon aria-hidden size={16} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 break-words">{n.message}</span>
                    </div>
                );
            })}
        </div>
    );
});
