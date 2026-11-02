import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatWorkspace, WorkspaceErrorBoundary } from "@pikvm/chat-ui";
import "./styles.css";

/* The desktop's console frames this build and sets the base before the bundle
   runs (see src/server/workspace.ts in the app); standalone, the harness serves
   it and there is no base. One built bundle, so the host says which it is. */
const apiBase = (globalThis as { __PIKVM_HARNESS_API_BASE__?: unknown })
  .__PIKVM_HARNESS_API_BASE__;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Outside the shell, not inside it: the throw that prompted this came from
        a useMemo in the shell itself, so a boundary within it would have gone
        down with it. */}
    <WorkspaceErrorBoundary>
      <ChatWorkspace
        apiBase={typeof apiBase === "string" ? apiBase : undefined}
        uiBuild={__PIKVM_UI_BUILD__}
      />
    </WorkspaceErrorBoundary>
  </StrictMode>,
);
