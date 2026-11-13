/**
 * "A new version is ready": a slim line under the connection banner, in the page's flow like it, so nothing is covered
 * and nothing needs a pointer. It is shown only when the page did not apply the update itself because the moment was
 * not quiet (update.ts). Reload applies it now; the cross dismisses it and the next quiet moment applies it.
 */

import { useSyncExternalStore } from "react";
import "./update-prompt.css";
import { dismissUpdatePrompt, promptTarget, reloadForUpdate, subscribePrompt } from "./update";

export function UpdatePrompt() {
    const target = useSyncExternalStore(subscribePrompt, promptTarget, promptTarget);
    return (
        <div className="update-slot" role="status" aria-live="polite" data-testid="update-slot" hidden={target === null}>
            {target === null ? null : (
                <div className="update-prompt" data-build={target}>
                    <span>A new version is ready.</span>
                    <button type="button" className="update-prompt-action" onClick={reloadForUpdate}>
                        Reload
                    </button>
                    <button type="button" className="update-prompt-dismiss" aria-label="Dismiss" onClick={dismissUpdatePrompt}>
                        {"\u00d7"}
                    </button>
                </div>
            )}
        </div>
    );
}
