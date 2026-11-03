/**
 * The health indicator: drawn only when the Pi (or the link to it) reports a problem, amber or
 * red by the worst one, and opening the System dialog. The desktop toolbar and the phone dock draw
 * the same button so a problem is visible wherever the screen is used.
 */

import { useMemo } from "react";
import type { DialogName } from "./dialog-seam";
import { healthProblems } from "./dialogs/model/health";
import { Heartbeat } from "@pikvm/icons";
import { useTarget } from "./session";

export function HealthButton({ className, openDialog }: { readonly className: string; readonly openDialog: (name: DialogName) => void }) {
    const device = useTarget((s) => s.device);
    const link = useTarget((s) => s.link);
    const problems = useMemo(
        () => healthProblems({ device, everSettled: link.everSettled, inputOpen: link.open }),
        [device, link.everSettled, link.open],
    );
    if (problems.length === 0) return null;
    return (
        <button
            type="button"
            className={`${className} kvm-health${problems.some((p) => p.level === "error") ? " is-error" : ""}`}
            data-testid="health"
            title={problems.map((p) => p.text).join("\n")}
            aria-label={`Health: ${problems.map((p) => p.text).join("; ")}`}
            onClick={() => openDialog("health")}
        >
            <Heartbeat />
        </button>
    );
}
