import {
  type ComponentProps,
  createContext,
  lazy,
  type CSSProperties,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AssistantRuntimeProvider,
  type ExternalStoreAdapter,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  ActivityIcon,
  BotIcon,
  GalleryVerticalEndIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PictureInPicture2Icon,
  SparklesIcon,
} from "lucide-react";
import { Thread } from "../assistant-ui/thread";
import { ThreadList } from "../assistant-ui/thread-list";
import { ToolFallback } from "../assistant-ui/tool-fallback";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { AuthDialog } from "./auth-dialog";
import { ComputerToolEnvironmentProvider } from "./computer-tool-environment";
import {
  belongsToComputerActivity,
  DeferredComputerToolCall as ComputerToolCall,
  DeferredWorkspaceToolGroup as WorkspaceToolGroup,
} from "./deferred-computer-tools";
import {
  hasFreshRunActivity,
  LiveUpdateBadge,
} from "./live-update-badge";
import { ModelPicker } from "./model-picker";
import {
  canComposeIntoRun,
  DirectRunBanner,
  RunControlModeBadge,
  usesManagedControlLoop,
} from "./run-control-mode";
import { RunProvenance } from "./run-provenance";
import { TaskRestoreState } from "./task-restore-state";
import { WorkspaceErrorBoundary } from "./workspace-error-boundary";
import { UiUpdateBadge } from "./ui-update-badge";
import { useHarnessWorkspace } from "../../hooks/use-harness-workspace";
import { ApprovalDockedProvider } from "../assistant-ui/approval-dock";
import { CompactProvider, useCompactLayout } from "../../layout/compact";
import { useKeyboardInset } from "../../layout/keyboard";
import { configureHarnessApi } from "../../lib/harness-api";
import {
  messagesForRun,
  type PendingApproval,
  pendingApprovalForRun,
} from "../../lib/run-messages";
import { HarnessUnavailable } from "./harness-unavailable";
import { PendingApprovalDock } from "./pending-approval-dock";
import type { RespondToToolApprovalOptions } from "@assistant-ui/react";
import { useConsoleTheme, usePanelPlacement } from "../../hooks/use-panel-placement";
import { cn } from "../../lib/utils";

const ComputerSheet = lazy(async () => {
  const module = await import("./computer-sheet");
  return { default: module.ComputerSheet };
});

const DiagnosticsSheet = lazy(async () => {
  const module = await import("./diagnostics-sheet");
  return { default: module.DiagnosticsSheet };
});

const ProviderConnectionsSheet = lazy(async () => {
  const module = await import(
    "./provider-connections-sheet"
  );
  return { default: module.ProviderConnectionsSheet };
});

const ShowcaseSheet = lazy(async () => {
  const module = await import("./showcase-sheet");
  return { default: module.ShowcaseSheet };
});

const useDeferredMount = (open: boolean) => {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted || open;
};

/* The assistant calls `computer_*`; `pikvm_*` is the raw MCP the harness drives
 * underneath and never appears in a turn. Matching on the pikvm_ prefix alone
 * meant EVERY computer tool call the user actually sees fell through to the
 * bare "Used tool: …" fallback, with the rich rendering never once used. */
const WorkspaceToolCall = (props: ToolCallMessagePartProps) =>
  belongsToComputerActivity(props.toolName) ? (
    <ComputerToolCall {...props} />
  ) : (
    <ToolFallback {...props} />
  );

/**
 * The console's titlebar buttons, to the pixel: 30px circles, 15px icons, muted
 * until hovered, with the hover and press backdrops mixed from currentColor so
 * they follow the theme. This panel sits in the same window as that titlebar, so
 * a button that is nearly the same reads as a mistake rather than a variation.
 *
 * Written as utilities rather than a component-layer class on purpose: the
 * button's own size and radius come from its cva variants, which live in the
 * utilities layer and win over anything declared in components.
 */
const TITLEBAR_BUTTON = [
  "size-[30px] shrink-0 rounded-full p-0 compact:size-11",
  "text-muted-foreground transition-colors hover:text-foreground",
  "hover:bg-[color-mix(in_srgb,currentColor_16%,transparent)]",
  "active:bg-[color-mix(in_srgb,currentColor_26%,transparent)] active:scale-100",
  // Important because the button's own [&_svg]:size-4 is the same specificity
  // and tw-merge does not treat the two arbitrary variants as a conflict.
  "[&_svg]:size-[15px]! compact:[&_svg]:size-5!",
].join(" ");

function RuntimeInstance({
  adapter,
  children,
}: {
  adapter: ExternalStoreAdapter<ThreadMessageLike>;
  children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export function WorkspaceRuntimeBoundary({
  runtimeKey,
  adapter,
  children,
}: {
  runtimeKey: string;
  adapter: ExternalStoreAdapter<ThreadMessageLike>;
  children: ReactNode;
}) {
  return (
    <RuntimeInstance key={runtimeKey} adapter={adapter}>
      {children}
    </RuntimeInstance>
  );
}

function SheetLoading({
  open,
  onOpenChange,
  title,
  side = "right",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side?: "left" | "right";
  className?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className={className}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Loading…</SheetDescription>
        </SheetHeader>
        <div
          className="flex flex-1 flex-col gap-3 px-4"
          role="status"
          aria-label={`Loading ${title.toLowerCase()}`}
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A sheet that could not render, shown as the sheet the user opened.
 *
 * Opening Recorded proof against a daemon that answered its endpoint with a
 * different shape threw during render, and with only the root boundary between
 * that sheet and the app the whole workspace went — conversation, sidebar,
 * composer — over a panel someone opened out of curiosity. Measured: TypeError
 * "e.tasks is not iterable", `#root` replaced by the root boundary's message.
 *
 * The failure belongs in the panel that caused it, with a way to close it and
 * a way to try again, and the conversation behind it left alone.
 */
function SheetFailure({
  open,
  onOpenChange,
  title,
  error,
  onRetry,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  error: Error;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onRetry();
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className={className}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            This panel could not be displayed. The agent daemon
            answered with something it did not understand, usually
            because the two are different versions.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col items-start gap-3 px-4" role="alert">
          <p className="font-mono text-xs break-words text-muted-foreground/80">
            {error.message}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export type ChatWorkspaceProps = {
  /** Where the harness API is mounted ("/app/harness" in the PiKVM app). Omit for same-origin /api. */
  apiBase?: string | undefined;
  /**
   * The host manages authentication: connect with this marker credential, never
   * prompt for a token and never offer to disconnect. A host that does this has
   * a proxy attaching the real operator capability server-side.
   */
  managedToken?: string | undefined;
  /** Phone layout. Omit to decide from the device (coarse pointer or narrow window). */
  compact?: boolean | undefined;
  /**
   * Who clears the notch and home indicator: "self" (default) pads for the safe
   * areas, "host" when the surrounding shell already has.
   */
  insets?: "self" | "host" | undefined;
  /** The build running, so the header can offer a reload when the server has a newer one. */
  uiBuild?: string | undefined;
};

type ToolbarProps = {
  show: boolean;
  picker: ComponentProps<typeof ModelPicker>;
};

const ComposerToolbarContext = createContext<ToolbarProps | null>(null);

/* Module-level components with their data in context, not closures built per render:
 * a component created inside the shell has a new identity every render, so React
 * would unmount and remount it on each streamed event, closing an open model sheet
 * (and resetting an approval's "submitted" state) under the person's thumb. */
function ComposerToolbarSlot() {
  const toolbar = useContext(ComposerToolbarContext);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {toolbar?.show ? <ModelPicker {...toolbar.picker} /> : null}
    </div>
  );
}

type DockState = {
  approval: PendingApproval;
  /** Bumped after a failed answer, so the controls mount fresh and are live again. */
  attempt: number;
  error: string | undefined;
  onRespond: (decision: RespondToToolApprovalOptions) => void;
};

const ApprovalDockContext = createContext<DockState | null>(null);

function ApprovalDockSlot() {
  const dock = useContext(ApprovalDockContext);
  if (!dock) return null;
  return (
    <PendingApprovalDock
      key={`${dock.approval.id}:${dock.attempt}`}
      approval={dock.approval}
      onRespond={dock.onRespond}
      error={dock.error}
    />
  );
}

const THREAD_COMPONENTS = {
  ComposerToolbar: ComposerToolbarSlot,
  AboveComposer: ApprovalDockSlot,
  ToolFallback: WorkspaceToolCall,
  ToolGroup: WorkspaceToolGroup,
};

export function ChatWorkspace({
  apiBase,
  managedToken,
  compact: compactOverride,
  insets = "self",
  uiBuild,
}: ChatWorkspaceProps) {
  // Before any child's effect can fetch: the API base is module state (lib/harness-api).
  useState(() => {
    if (apiBase !== undefined) configureHarnessApi({ apiBase });
  });
  const managed = managedToken !== undefined;
  const detectedCompact = useCompactLayout();
  const compact = compactOverride ?? detectedCompact;
  const rootRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset(rootRef, compact);
  const workspace = useHarnessWorkspace({ managedToken });
  const panel = usePanelPlacement();
  useConsoleTheme();
  const [computerOpen, setComputerOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [showcaseOpen, setShowcaseOpen] = useState(false);
  const computerMounted = useDeferredMount(computerOpen);
  const modelsMounted = useDeferredMount(modelsOpen);
  const diagnosticsMounted = useDeferredMount(diagnosticsOpen);
  const showcaseMounted = useDeferredMount(showcaseOpen);
  const selectedSummary = workspace.selectedId
    ? workspace.runs.find((run) => run.run_id === workspace.selectedId)
    : undefined;
  // "New task" everywhere: the button that creates one, the sheet that lists
  // them, its search field and the list's own fallback title all say task, so a
  // header reading "New chat" was a second name for the same untitled run, one
  // click away from the first. Kept in step with ThreadListItemGroups.
  const selectedTaskTitle =
    workspace.selectedRun?.task || selectedSummary?.task || "New task";
  const selectedRunPending = Boolean(
    workspace.selectedId &&
      workspace.selectedRun?.run_id !== workspace.selectedId,
  );
  const managedControl = usesManagedControlLoop(
    workspace.selectedRun?.origin,
  );

  useEffect(() => {
    if (!managedControl) setModelsOpen(false);
  }, [managedControl]);

  const messages = useMemo(
    () => messagesForRun(workspace.selectedRun),
    [workspace.selectedRun],
  );
  const computerEnvironment = useMemo(() => {
    const machine = workspace.selectedRun?.observation?.machine;
    return {
      token: workspace.token,
      runId: workspace.selectedRun?.run_id,
      machineName:
        machine && typeof machine.alias === "string"
          ? machine.alias
          : "Managed computer",
      currentFrameId: workspace.selectedRun?.observation?.frame_id ?? undefined,
      screenWidth: workspace.selectedRun?.observation?.width ?? undefined,
      screenHeight: workspace.selectedRun?.observation?.height ?? undefined,
      onOpenComputer: () => setComputerOpen(true),
    };
  }, [
    workspace.selectedRun?.run_id,
    workspace.selectedRun?.observation?.frame_id,
    workspace.selectedRun?.observation?.height,
    workspace.selectedRun?.observation?.machine,
    workspace.selectedRun?.observation?.width,
    workspace.token,
  ]);
  const threadList = useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: workspace.selectedId ?? undefined,
      threads: workspace.runs.map((run) => ({
        id: run.run_id,
        remoteId: run.run_id,
        status: "regular",
        title: run.task,
        /* When it last moved and how it ended, so the list can tell similar
           tasks apart. ExternalStoreThreadData carries no lastMessageAt field —
           only this custom record — which is why the list's own relative time
           and its Today/Yesterday grouping had never once rendered. */
        custom: { updatedAt: run.updated_at, runStatus: run.status },
      })),
      archivedThreads: [],
      onSwitchToNewThread: () => {
        workspace.newThread();
        setTasksOpen(false);
      },
      onSwitchToThread: async (threadId) => {
        setTasksOpen(false);
        await workspace.selectRun(threadId);
      },
    }),
    [
      workspace.newThread,
      workspace.runs,
      workspace.selectRun,
      workspace.selectedId,
    ],
  );
  const runtimeAdapter: ExternalStoreAdapter<ThreadMessageLike> = {
    messages,
    convertMessage: (message) => message,
    isRunning: workspace.isRunning,
    isSendDisabled:
      selectedRunPending ||
      !canComposeIntoRun(
        workspace.connected,
        workspace.selectedRun?.origin,
      ),
    onNew: workspace.onNew,
    onCancel: workspace.onCancel,
    onRespondToToolApproval: workspace.respondToApproval,
    adapters: { threadList },
    unstable_capabilities: { copy: true },
  };

  const toolbar = useMemo<ToolbarProps>(
    () => ({
      show: managedControl,
      picker: {
        providers: workspace.providers,
        preferences: workspace.modelPreferences,
        activeRoute: workspace.selectedRun?.model_route,
        activeProvider: workspace.selectedRun?.model_provider,
        locked: workspace.routeLocked,
        onPreferenceChange: workspace.setModelPreference,
        onResetPreferences: workspace.resetModelPreferences,
        onOpenModels: () => setModelsOpen(true),
      },
    }),
    [
      managedControl,
      workspace.modelPreferences,
      workspace.providers,
      workspace.resetModelPreferences,
      workspace.routeLocked,
      workspace.selectedRun?.model_provider,
      workspace.selectedRun?.model_route,
      workspace.setModelPreference,
    ],
  );

  /* The approval the agent is stopped on. On a phone it is answered in a dock above the
   * composer (the thread card is then informational), on a wide screen in the card. A
   * failed answer re-arms the controls: the dock is remounted by bumping its key. */
  const pendingApproval = useMemo(
    () => pendingApprovalForRun(workspace.selectedRun),
    [workspace.selectedRun],
  );
  const docked = compact && pendingApproval !== null;
  const [dockError, setDockError] = useState<string | undefined>();
  const [dockAttempt, setDockAttempt] = useState(0);
  const respondToApproval = workspace.respondToApproval;
  const dock = useMemo<DockState | null>(
    () =>
      docked && pendingApproval
        ? {
            approval: pendingApproval,
            attempt: dockAttempt,
            error: dockError,
            onRespond: (decision) => {
              setDockError(undefined);
              respondToApproval(decision).catch((cause: unknown) => {
                setDockError(
                  cause instanceof Error
                    ? cause.message
                    : "The answer did not go through.",
                );
                setDockAttempt((attempt) => attempt + 1);
              });
            },
          }
        : null,
    [docked, dockAttempt, dockError, pendingApproval, respondToApproval],
  );
  useEffect(() => {
    setDockError(undefined);
  }, [pendingApproval?.id]);

  const rootStyle = {
    "--chat-keyboard-inset": `${keyboard.inset}px`,
  } as CSSProperties;
  const rootAttributes = {
    "data-layout": compact ? "compact" : "wide",
    "data-keyboard": keyboard.open ? "open" : "closed",
    "data-insets": insets,
  } as const;

  if (managed && !workspace.connected) {
    return (
      <CompactProvider compact={compact} insets={insets}>
        <div
          ref={rootRef}
          className="workspace-shell"
          style={rootStyle}
          {...rootAttributes}
        >
          <main className="workspace-main">
            <HarnessUnavailable
              failure={workspace.connectFailure}
              connecting={workspace.loading || workspace.connectFailure === null}
              onRetry={() => void workspace.connect(managedToken)}
            />
          </main>
        </div>
      </CompactProvider>
    );
  }

  return (
    <CompactProvider compact={compact} insets={insets}>
    <WorkspaceRuntimeBoundary
      runtimeKey={workspace.selectedId ?? "new-task"}
      adapter={runtimeAdapter}
    >
      <div
        ref={rootRef}
        className="workspace-shell"
        style={rootStyle}
        {...rootAttributes}
      >
        {compact ? null : (
        <aside className="workspace-rail">
          {/* A compact rail header, VS Code style: a section label rather than
              a brand block. The window title already says what this is. */}
          <div className="flex h-10 items-center gap-2 px-3">
            <SparklesIcon
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Sessions
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <ThreadList />
          </div>
        </aside>
        )}

        <main className="workspace-main">
          <header className="workspace-header">
            <div className="flex min-w-0 items-center gap-2">
              {compact ? (
                <TooltipIconButton
                  tooltip="Tasks"
                  aria-label="Open tasks"
                  className={TITLEBAR_BUTTON}
                  onClick={() => setTasksOpen(true)}
                >
                  <MenuIcon />
                </TooltipIconButton>
              ) : null}
              {/* The console titlebar's own title treatment: small, semibold and
                  muted, so the run name reads as a window title rather than as
                  the first line of the conversation. */}
              <p className="truncate text-[12.5px] font-semibold text-muted-foreground">
                {selectedTaskTitle}
              </p>
              {/* Only states that change what the user should do next earn a
                  place beside the title. A healthy live connection is the
                  expected case and says nothing, so it stays silent; the badge
                  appears when the stream degrades. Provenance and the UI-update
                  prompt are rare, and keep their own conditional badges. */}
              {workspace.selectedRun?.origin === "direct_mcp" ? (
                <>
                  <RunControlModeBadge origin={workspace.selectedRun.origin} />
                  <RunProvenance caller={workspace.selectedRun.caller} />
                </>
              ) : null}
              {workspace.connected ? (
                <>
                  {selectedRunPending ? (
                    <Badge
                      variant={
                        workspace.restoringRun ? "outline" : "destructive"
                      }
                      aria-live="polite"
                    >
                      {workspace.restoringRun
                        ? "Restoring"
                        : "Task unavailable"}
                    </Badge>
                  ) : workspace.selectedRun &&
                    workspace.liveUpdateStatus !== "live" ? (
                    <LiveUpdateBadge status={workspace.liveUpdateStatus} />
                  ) : null}
                  {uiBuild ? <UiUpdateBadge current={uiBuild} /> : null}
                </>
              ) : null}
            </div>
            {/* One overflow menu rather than a row of five icons. Everything
                here is occasional; the frequent controls live by the composer,
                where the work happens. */}
            <div className="flex shrink-0 items-center gap-1">
              {/* Where this panel sits is a fact about the panel, so the controls
                  live in its own header rather than in the console's overflow
                  menu, which belongs to the other half of the window. Absent
                  outside the desktop app, where there is no panel to place. */}
              {panel.available && panel.placement && !panel.placement.detached ? (
                <TooltipIconButton
                  tooltip={
                    panel.placement.side === "right"
                      ? "Move to the left"
                      : "Move to the right"
                  }
                  aria-label={
                    panel.placement.side === "right"
                      ? "Move the conversation to the left side"
                      : "Move the conversation to the right side"
                  }
                  className={TITLEBAR_BUTTON}
                  onClick={() =>
                    panel.setSide(
                      panel.placement?.side === "right" ? "left" : "right",
                    )
                  }
                >
                  {panel.placement.side === "right" ? (
                    <PanelLeftIcon />
                  ) : (
                    <PanelRightIcon />
                  )}
                </TooltipIconButton>
              ) : null}
              {panel.available && panel.placement ? (
                <TooltipIconButton
                  tooltip={
                    panel.placement.detached ? "Put back" : "Open in its own window"
                  }
                  aria-label={
                    panel.placement.detached
                      ? "Bring the conversation back into the console window"
                      : "Open the conversation in its own window"
                  }
                  className={TITLEBAR_BUTTON}
                  onClick={panel.toggleDetached}
                >
                  <PictureInPicture2Icon />
                </TooltipIconButton>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <TooltipIconButton
                      tooltip="More"
                      aria-label="More workspace actions"
                      className={TITLEBAR_BUTTON}
                    >
                      <MoreHorizontalIcon />
                    </TooltipIconButton>
                  }
                />
                <DropdownMenuContent>
                  {managedControl ? (
                    <DropdownMenuItem
                      disabled={!workspace.connected}
                      onClick={() => setModelsOpen(true)}
                    >
                      <BotIcon aria-hidden="true" />
                      Models
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    disabled={!workspace.connected}
                    onClick={() => setComputerOpen(true)}
                  >
                    <MonitorIcon aria-hidden="true" />
                    Computer
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!workspace.connected}
                    onClick={() => setShowcaseOpen(true)}
                  >
                    <GalleryVerticalEndIcon aria-hidden="true" />
                    Recorded proof
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!workspace.selectedRun}
                    onClick={() => setDiagnosticsOpen(true)}
                  >
                    <ActivityIcon aria-hidden="true" />
                    Diagnostics
                  </DropdownMenuItem>
                  {managed ? null : (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={!workspace.connected}
                        onClick={workspace.disconnect}
                      >
                        <LogOutIcon aria-hidden="true" />
                        Disconnect
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <section className="workspace-thread" aria-label="Agent conversation">
            {workspace.error && workspace.connected && !selectedRunPending ? (
              <Alert variant="destructive" className="workspace-error">
                <AlertDescription>{workspace.error}</AlertDescription>
              </Alert>
            ) : null}
            {selectedRunPending ? (
              <TaskRestoreState
                task={
                  workspace.selectedRun?.task || selectedSummary?.task
                }
                runId={workspace.selectedId}
                restoring={workspace.restoringRun}
                detail={workspace.error}
                onRetry={() => {
                  if (workspace.selectedId) {
                    void workspace.selectRun(workspace.selectedId);
                  }
                }}
                onNewTask={workspace.newThread}
              />
            ) : (
              <>
                {workspace.selectedRun?.origin === "direct_mcp" &&
                !workspace.error ? (
                  <DirectRunBanner
                    caller={workspace.selectedRun.caller}
                    onStartManaged={workspace.newThread}
                  />
                ) : null}
                <ComputerToolEnvironmentProvider value={computerEnvironment}>
                  <ComposerToolbarContext.Provider value={toolbar}>
                    <ApprovalDockContext.Provider value={dock}>
                      <ApprovalDockedProvider value={docked}>
                        <div className="flex min-h-0 flex-1 flex-col">
                          <Thread
                            readOnly={!managedControl}
                            activity={workspace.selectedRun?.active_activity}
                            working={
                              workspace.isRunning &&
                              hasFreshRunActivity(workspace.liveUpdateStatus)
                            }
                            components={THREAD_COMPONENTS}
                          />
                        </div>
                      </ApprovalDockedProvider>
                    </ApprovalDockContext.Provider>
                  </ComposerToolbarContext.Provider>
                </ComputerToolEnvironmentProvider>
              </>
            )}
          </section>
        </main>
      </div>

      <Sheet open={tasksOpen && compact} onOpenChange={setTasksOpen}>
        <SheetContent
          side="left"
          className="w-[min(88vw,22rem)] data-[side=left]:w-[min(88vw,22rem)] pt-[var(--chat-safe-top,0px)]"
        >
          <SheetHeader>
            <SheetTitle>Tasks</SheetTitle>
            <SheetDescription>
              Switch conversations or start a new task.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <ThreadList />
          </div>
        </SheetContent>
      </Sheet>

      {computerMounted ? (
        <WorkspaceErrorBoundary
          scope="computer"
          fallback={(error, reset) => (
            <SheetFailure
              open={computerOpen}
              onOpenChange={setComputerOpen}
              title="Computer"
              error={error}
              onRetry={reset}
              className="computer-sheet"
            />
          )}
        >
          <Suspense
            fallback={
              <SheetLoading
                open={computerOpen}
                onOpenChange={setComputerOpen}
                title="Computer"
                className="computer-sheet"
              />
            }
          >
            <ComputerSheet
              open={computerOpen}
              onOpenChange={setComputerOpen}
              token={workspace.token}
              run={workspace.selectedRun}
              connectionEnabled={workspace.computerControlEnabled}
              connectionMcpName={workspace.computerConnection.mcpServerName}
              connectionMachineName={workspace.computerConnection.machineName}
              onPause={workspace.onCancel}
              onContinue={workspace.continueRun}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      ) : null}
      {managedControl && modelsMounted ? (
        <WorkspaceErrorBoundary
          scope="models"
          fallback={(error, reset) => (
            <SheetFailure
              open={modelsOpen}
              onOpenChange={setModelsOpen}
              title="Models"
              error={error}
              onRetry={reset}
            />
          )}
        >
          <Suspense
            fallback={
              <SheetLoading
                open={modelsOpen}
                onOpenChange={setModelsOpen}
                title="Models"
              />
            }
          >
            <ProviderConnectionsSheet
              open={modelsOpen}
              onOpenChange={setModelsOpen}
              providers={workspace.providers}
              catalog={workspace.providerCatalog}
              modelCatalog={workspace.modelCatalog}
              preferences={workspace.modelPreferences}
              activeRoute={workspace.selectedRun?.model_route}
              activeProvider={workspace.selectedRun?.model_provider}
              locked={workspace.routeLocked}
              onPreferenceChange={workspace.setModelPreference}
              onResetPreferences={workspace.resetModelPreferences}
              connectingProvider={workspace.connectingProvider}
              onConnectProvider={workspace.connectProvider}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      ) : null}
      {diagnosticsMounted ? (
        <WorkspaceErrorBoundary
          scope="diagnostics"
          fallback={(error, reset) => (
            <SheetFailure
              open={diagnosticsOpen}
              onOpenChange={setDiagnosticsOpen}
              title="Diagnostics"
              error={error}
              onRetry={reset}
            />
          )}
        >
          <Suspense
            fallback={
              <SheetLoading
                open={diagnosticsOpen}
                onOpenChange={setDiagnosticsOpen}
                title="Diagnostics"
              />
            }
          >
            <DiagnosticsSheet
              open={diagnosticsOpen}
              onOpenChange={setDiagnosticsOpen}
              run={workspace.selectedRun}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      ) : null}
      {showcaseMounted ? (
        <WorkspaceErrorBoundary
          scope="recorded-proof"
          fallback={(error, reset) => (
            <SheetFailure
              open={showcaseOpen}
              onOpenChange={setShowcaseOpen}
              title="Recorded proof"
              error={error}
              onRetry={reset}
              className="showcase-sheet"
            />
          )}
        >
          <Suspense
            fallback={
              <SheetLoading
                open={showcaseOpen}
                onOpenChange={setShowcaseOpen}
                title="Recorded proof"
                className="showcase-sheet"
              />
            }
          >
            <ShowcaseSheet
              open={showcaseOpen}
              onOpenChange={setShowcaseOpen}
              token={workspace.token}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      ) : null}
      <AuthDialog
        open={!managed && !workspace.connected}
        loading={workspace.loading}
        error={workspace.error}
        onConnect={workspace.connect}
      />
    </WorkspaceRuntimeBoundary>
    </CompactProvider>
  );
}
