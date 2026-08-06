import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceErrorBoundary } from "@/components/workspace/workspace-error-boundary";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Outside the shell, not inside it: the throw that prompted this came from
        a useMemo in the shell itself, so a boundary within it would have gone
        down with it. */}
    <WorkspaceErrorBoundary>
      <WorkspaceShell />
    </WorkspaceErrorBoundary>
  </StrictMode>,
);
