export type RunStatus =
  | "created"
  | "planning"
  | "running"
  | "executing"
  | "verifying"
  | "paused"
  | "needs_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "rejected"
  | "aborted";

export type HarnessEvent = {
  sequence: number;
  at: string;
  kind: string;
  data: Record<string, unknown>;
};

export type LiveUpdateStatus =
  "idle" | "connecting" | "live" | "retrying" | "offline";

export type HarnessHealth = {
  status: string;
  control_mode?: string | undefined;
  direct_call_visibility?: "enabled" | "disabled" | undefined;
  computer_control?: "enabled" | "disabled" | undefined;
};

export type ComputerConnection = {
  enabled: boolean;
  mcpServerName: string;
  machineName: string;
};

export type ShowcaseTask = {
  task_id: string;
  title: string;
  category: string;
  prompt: string;
  mutates_workspace: boolean;
  status:
    | "queued"
    | "running"
    | "rebooting"
    | "passed"
    | "failed";
  run_id?: string | null | undefined;
  started_at?: string | null | undefined;
  finished_at?: string | null | undefined;
  duration_ms?: number | null | undefined;
  result?: {
    status?: string | undefined;
    error?: string | null | undefined;
    event_count?: number | undefined;
    active_activity?: Record<string, unknown> | null | undefined;
  } | null | undefined;
  error?: string | null | undefined;
  performance?: Record<string, unknown> | null | undefined;
  approvals?: Array<Record<string, unknown>> | undefined;
  reboot: {
    status: "pending" | "running" | "ready" | "failed";
    requested_at?: string | null | undefined;
    ready_at?: string | null | undefined;
    duration_ms?: number | null | undefined;
    transition_observed: boolean;
    attempts?: Array<{
      attempt: number;
      duration_ms: number;
      transition_observed: boolean;
      ready_frame_sha256: string;
    }> | undefined;
  };
  recording?: string | null | undefined;
  poster?: string | null | undefined;
};

export type ShowcaseCampaign = {
  schema_version: 1;
  campaign_id: string;
  source_campaign_id?: string | null | undefined;
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  model?: { provider?: string } | undefined;
  isolation?: {
    reboot_after_every_task?: boolean | undefined;
    ready_gate?: string | undefined;
  } | undefined;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  current_task_id?: string | null | undefined;
  current_run_id?: string | null | undefined;
  started_at?: string | null | undefined;
  finished_at?: string | null | undefined;
  updated_at: string;
  tasks: ShowcaseTask[];
};

export type ModelRole =
  | "assistant"
  | "reasoner"
  | "controller"
  | "verifier";

export type ModelPreferences = Partial<Record<ModelRole, string>>;

export type RunModelRoute = Partial<Record<ModelRole, string[]>>;

export type RunSummary = {
  run_id: string;
  task: string;
  status: RunStatus;
  mode?: "assistant" | "computer" | undefined;
  origin: "managed" | "direct_mcp";
  model_provider?: string | null | undefined;
  model_route?: RunModelRoute | null | undefined;
  caller?: Record<string, unknown> | undefined;
  session_id?: string | null | undefined;
  created_at: string;
  updated_at: string;
  event_count: number;
  event_cursor: number;
  error?: string | null | undefined;
};

export type RunSnapshot = RunSummary & {
  computer_task?: string | null | undefined;
  conversation?: Array<{
    message_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
    event_cursor?: number | undefined;
  }> | undefined;
  plan?: {
    summary: string;
    steps: string[];
    success_criteria: string[];
    constraints: string[];
  } | null | undefined;
  operator_guidance: string[];
  observation?: {
    session_id: string;
    status: string;
    machine: Record<string, unknown>;
    frame_id?: number | null | undefined;
    world_version?: number | null | undefined;
    control_epoch?: number | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
    image_sha256?: string | null | undefined;
    screen_hash?: string | null | undefined;
  } | null | undefined;
  pending_action?: {
    index: number;
    intent: string;
    actions: Array<Record<string, unknown>>;
    expected_evidence: string[];
    based_on_world_version: number;
    based_on_control_epoch: number;
    idempotency_key: string;
    attempts: number;
  } | null | undefined;
  pending_approval?: Record<string, unknown> | null | undefined;
  last_verification?: Record<string, unknown> | null | undefined;
  verification_image_available?: boolean | undefined;
  verification_image_revision?: number | undefined;
  verification_images?: Array<{
    revision: number;
    action_index: number;
    kind?: "before_after" | "pre_action" | undefined;
    before_frame_id?: number | null | undefined;
    after_frame_id?: number | null | undefined;
  }> | undefined;
  active_activity?: {
    kind: "model" | "tool";
    started_at: string;
    phase?:
      | "queued"
      | "provider_selected"
      | "request_sent"
      | "output_received"
      | "validating"
      | "schema_repair"
      | "failover"
      | null;
    role?: string | null | undefined;
    provider?: string | null | undefined;
    model?: string | null | undefined;
    attempt?: number | null | undefined;
    tool?: string | null | undefined;
    call_id?: string | null | undefined;
    arguments?: Record<string, unknown> | undefined;
  } | null | undefined;
  events: HarnessEvent[];
  events_truncated: boolean;
  timeline_events?: HarnessEvent[] | undefined;
  timeline_events_truncated?: boolean | undefined;
};

export type ProviderHealth = {
  kind?: string | undefined;
  configured_model?: string | undefined;
  billing_mode?: string | undefined;
  interface?: string | undefined;
  pixel_input?: string | undefined;
  computer_screen_input?: boolean | undefined;
  structured_output?: string | undefined;
  ready?: boolean | undefined;
  support_tier?: string | undefined;
  implementation_contract?: string | undefined;
  auth_mode?: string | undefined;
  credential_owner?: string | undefined;
  readiness_error?: string | null | undefined;
  routes?: Array<{
    role?: string | undefined;
    position?: number | undefined;
  }> | undefined;
  calls?: number | undefined;
  successes?: number | undefined;
  failures?: number | undefined;
  skipped?: number | undefined;
  consecutive_failures?: number | undefined;
  last_latency_ms?: number | null | undefined;
  last_model?: string | null | undefined;
  last_success_at?: string | null | undefined;
  cooldown_until?: string | null | undefined;
  conformance_status?: string | undefined;
  conformance_created_at?: string | undefined;
  conformance_cases_requested?: number | undefined;
  conformance_calls_attempted?: number | undefined;
  conformance_schema_valid?: number | undefined;
  conformance_exact?: number | undefined;
  conformance_normalized_exact?: number | undefined;
  conformance_exact_accuracy?: number | undefined;
  conformance_normalized_exact_accuracy?: number | undefined;
  conformance_median_latency_ms?: number | undefined;
  conformance_p95_latency_ms?: number | undefined;
  conformance_failure_counts?: Record<string, number> | undefined;
};

export type ProviderMap = Record<string, ProviderHealth>;

export type ProviderCatalogAuth = {
  mode: string;
  credential_owner: string;
};

export type ProviderCatalogEntry = {
  kind: string;
  support_tier: string;
  implementation_contract: string;
  interface: string;
  pixel_input: string;
  structured_output: string;
  auth: ProviderCatalogAuth[];
};

export type ConnectableProviderKind =
  | "codex_cli"
  | "codex_app_server"
  | "claude_cli"
  | "gemini_cli"
  | "openai_responses"
  | "anthropic_api"
  | "gemini_api"
  | "openai_compatible"
  | "azure_openai_responses"
  | "vertex_gemini";

export type ProviderConnectionAuthMode =
  | "api_key"
  | "bearer_env"
  | "bearer_command";

export type ProviderConnectionInput = {
  alias: string;
  kind: ConnectableProviderKind;
  model: string;
  base_url?: string | undefined;
  credential_env?: string | undefined;
  profile_home_env?: string | undefined;
  auth_mode?: ProviderConnectionAuthMode | undefined;
};

export type ProviderConnectionResult = {
  provider: string;
  configured_model: string;
  kind: string;
  ready: boolean;
  credential_owner: string;
  readiness_error?: string | null | undefined;
  configured_not_routed: boolean;
  secret_received: false;
};

export type AssistantTool = {
  name: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
  destructive: boolean;
  open_world: boolean;
};

export type AssistantToolServerMap = Record<
  string,
  {
    ready: boolean;
    tools: number;
    error?: string | null | undefined;
  }
>;

/** Public model metadata from the harness's models.dev cache (secret-free). */
export type CatalogModel = {
  id: string;
  name: string;
  family?: string | null | undefined;
  reasoning: boolean;
  image_input: boolean;
  context?: number | null | undefined;
  output_limit?: number | null | undefined;
  cost_input?: number | null | undefined;
  cost_output?: number | null | undefined;
  release_date?: string | null | undefined;
};

export type ModelCatalogProvider = {
  id: string;
  name: string;
  logo_url: string;
  models: CatalogModel[];
};

export type ModelCatalog = {
  available: boolean;
  fetched_at?: number | null | undefined;
  /** models.dev provider id → provider entry with its usable models. */
  providers: Record<string, ModelCatalogProvider>;
  /** Our adapter kind → the models.dev provider ids whose models it can run. */
  kinds: Record<string, string[]>;
};

export const EMPTY_MODEL_CATALOG: ModelCatalog = {
  available: false,
  providers: {},
  kinds: {},
};
