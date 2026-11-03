/**
 * Wire protocol for `/v1/responses` (WebSocket), modelled on the OpenAI Responses API WebSocket mode.
 * Items and events keep Responses names and shapes where one exists; Chat-only additions use a
 * `chat.` prefix. The same item types are returned by `GET /api/conversations/:id/items`, so the
 * client renders history and live output with one code path.
 */

import type { ChatHelloEvent, ChatSyncEvent } from "./realtime.ts";

// Content parts

export interface InputText {
    type: "input_text";
    text: string;
}
export interface InputImage {
    type: "input_image";
    /** Served URL (`/api/uploads/:id`) or a data URL. */
    image_url: string;
    upload_id?: string;
    /** The composer chip this image stands for in the text, for example "[Image #2]". */
    marker?: string;
}
export interface InputFile {
    type: "input_file";
    upload_id: string;
    filename: string;
    /** The composer chip this file stands for in the text, for example "[Pasted text #1]". */
    marker?: string;
}
/**
 * Responses `url_citation`: the span `[start_index, end_index)` of `text` cites `url`. Chat fills these
 * for markdown links whose URL is a source collected in the same response (see `SourceRef`). Indices
 * are UTF-16 code unit offsets into the final text, as JavaScript string indices.
 */
export interface UrlCitation {
    type: "url_citation";
    start_index: number;
    end_index: number;
    url: string;
    title: string;
}

/** Annotation on an `output_text` part. Unknown annotation types are passed through untouched. */
export type Annotation = UrlCitation | { type: string; [key: string]: unknown };

export interface OutputText {
    type: "output_text";
    text: string;
    annotations: Annotation[];
}

/**
 * Chat extension: a web source found by a tool (web search result, fetched page). Collected by the
 * server from the tool's structured result so clients do not have to parse tool text.
 */
export interface SourceRef {
    url: string;
    title?: string;
    /** Short excerpt from the search result. */
    snippet?: string;
    /** Publication date as the provider reported it (free text, for example "2 days ago"). */
    published?: string;
}
export interface ReasoningText {
    type: "reasoning_text";
    text: string;
}

// Items

export type ItemStatus = "in_progress" | "completed" | "incomplete";

export interface MessageItem {
    id: string;
    type: "message";
    role: "user" | "assistant";
    status: ItemStatus;
    content: (InputText | InputImage | InputFile | OutputText)[];
    /** When the message started (ms). For an assistant message this is the start of the reply, not its end. */
    created_at?: number;
    /** Chat extension, stored history only: when an assistant message was finished and written (ms). */
    completed_at?: number;
    /**
     * Chat extension: tokens in the context window after the model call that wrote this assistant message (the
     * prompt it read plus the reply). The newest value in a chat is how full the window is. Stored history only;
     * a live response reports the same number as `Usage.context_tokens`.
     */
    context_tokens?: number;
    /**
     * Chat extension: the versions of a user message that was edited (docs/spec/thread-branching.md section 6).
     * `ids` are the item ids of every version, oldest first; `index` is this one's place in it. Absent when the
     * message has one version. Stored history only.
     */
    versions?: MessageVersions;
}

export interface MessageVersions {
    ids: string[];
    index: number;
}

export interface ReasoningItem {
    id: string;
    type: "reasoning";
    status: ItemStatus;
    summary: { type: "summary_text"; text: string }[];
    content: ReasoningText[];
}

export interface FunctionCallItem {
    id: string;
    type: "function_call";
    status: ItemStatus;
    call_id: string;
    name: string;
    /** JSON-encoded arguments, as in the Responses API. */
    arguments: string;
}

export interface FunctionCallOutputItem {
    id: string;
    type: "function_call_output";
    status: ItemStatus;
    call_id: string;
    output: string;
    /** Chat extension: the tool reported an error. */
    is_error?: boolean;
    /** Chat extension: web sources in this result, in the order the tool listed them. */
    sources?: SourceRef[];
    /** Chat extension: the subagents a `task` call started, one per task, with live progress. */
    subagents?: SubagentRun[];
    /** Chat extension: the whole task list after a `todo` call (the assistant's working plan), in phase order. */
    todos?: TodoPhase[];
    /**
     * Chat extension: epoch ms when the tool started running, for a clock on a running step. Live runs only: the
     * runtime's session file records no start time, so history items have none.
     */
    started_at?: number;
    /** Chat extension: the unified diff an `edit` call applied, with removed lines. */
    diff?: string;
    /** Chat extension: the exit code of a `bash` command that exited with a non-zero code. */
    exit_code?: number;
    /** Chat extension: how long a `bash` command ran, in milliseconds. */
    wall_time_ms?: number;
    /** Chat extension: the tool call ended because the user pressed Stop (not because it failed). */
    aborted?: boolean;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** Chat extension: one task of the assistant's working plan. */
export interface TodoTask {
    content: string;
    status: TodoStatus;
    /** For `blocked`: what the task waits for. */
    blocker?: string;
}

/** Chat extension: a named group of tasks in the assistant's working plan. */
export interface TodoPhase {
    name: string;
    tasks: TodoTask[];
}

/**
 * Chat extension: one tool call made inside a subagent. Uses the same tool names as top-level
 * `function_call` items, so clients can draw it with the same step vocabulary.
 */
export interface SubagentStep {
    /** Tool name, as in `FunctionCallItem.name`. */
    tool: string;
    /** One-line preview of the arguments: the command, path, query or URL. */
    label: string;
    /** Why the agent made the call, in its own words. */
    intent?: string;
    status: "running" | "completed" | "failed";
    /** Web sources the call returned (web search results, a fetched page). At most 8. */
    sources?: SourceRef[];
}

/** Chat extension: a subagent started by the `task` tool. */
export interface SubagentRun {
    /** Runtime agent id, unique in the conversation; also the key for its transcript. */
    id: string;
    /** Agent type, for example "task" or "scout". */
    agent: string;
    /** The assignment as the parent agent wrote it. */
    task: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    /** Epoch ms when the subagent started, for a live clock. Absent while pending. */
    started_at?: number;
    duration_ms: number;
    /** One line for what it is doing now (running only). */
    now?: string;
    /** Tool calls in order. Live runs carry what has been seen so far. */
    steps: SubagentStep[];
    tool_count: number;
    tokens?: number;
    /**
     * The model the subagent ran on, as a catalogue id (`provider/modelId`). Absent until the runtime reports
     * it, and in history written before the runtime recorded it with no model in the subagent's own session.
     */
    model?: string;
    /** Final output (completed) or the partial output it produced. */
    result?: string;
    /** Why it failed or was stopped. */
    error?: string;
}

/** The agent wants permission to run a tool. Answered with an `mcp_approval_response` input item. */
export interface ApprovalRequestItem {
    id: string;
    type: "mcp_approval_request";
    server_label: string;
    name: string;
    arguments: string;
    /** Chat extension: human-readable prompt from the runtime. */
    title: string;
    /**
     * Chat extension: set when the MCP gateway asks (not the runtime). `destructive` means the server marked the tool
     * as one that can destroy data (`agent.mcpApprovals.confirmDestructive`). `hints` are the server's annotations.
     */
    reason?: "destructive";
    hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
    /** Chat extension: the `function_call` this approval is for, when known. */
    call_id?: string;
}

/**
 * Chat extension: an MCP server asks the user for input (MCP elicitation). `form` carries a flat JSON schema of
 * strings, numbers, booleans and enums; `url` asks the user to open a page (sign-in, payment) and never carries the
 * page itself. Answered with a `chat.mcp_elicitation_response` input item; the item stays in the thread as a record.
 */
export interface McpElicitationItem {
    id: string;
    type: "chat.mcp_elicitation";
    status: ItemStatus;
    /** The `agent.mcp` record id of the server that asks. */
    server_label: string;
    mode: "form" | "url";
    message: string;
    /** Form mode: `{ type: "object", properties, required }` as the server sent it. */
    requested_schema?: Record<string, unknown>;
    /** URL mode: the address to open. */
    url?: string;
    /** The tool call the request belongs to, when known. */
    call_id?: string;
    outcome?: "accept" | "decline" | "cancel";
}

export type McpElicitationValue = string | number | boolean | string[];

export interface McpElicitationResponseItem {
    type: "chat.mcp_elicitation_response";
    elicitation_id: string;
    action: "accept" | "decline" | "cancel";
    /** Form mode with `accept`: one value per schema property. */
    content?: Record<string, McpElicitationValue>;
}

export interface ApprovalResponseItem {
    type: "mcp_approval_response";
    approval_request_id: string;
    approve: boolean;
}

/** Chat extension: one choice of a question. */
export interface QuestionOption {
    label: string;
    description?: string;
    /** Longer preview text the agent attached to the option (code, a plan). */
    preview?: string;
}

/** Chat extension: one question the agent asks. */
export interface Question {
    id: string;
    question: string;
    /** Short chip above the question, for example "Database". */
    header?: string;
    options: QuestionOption[];
    /** Several options can be picked. */
    multi?: boolean;
    /** Index into `options` of the option the agent recommends (also the answer on timeout). */
    recommended?: number;
}

/** Chat extension: the answer to one question. `selected` holds exact option labels. */
export interface QuestionAnswer {
    id: string;
    selected: string[];
    /** Free text, typed instead of (or, for multi-select, besides) the options. */
    text?: string;
    /** The user skipped this question; the agent continued without an answer. */
    skipped?: boolean;
    /** Nobody answered in time; `selected` is the recommended option. */
    timed_out?: boolean;
}

/**
 * Where a question came from. `ask` is the agent's question tool (one or more questions); the others
 * are single prompts from runtime extensions: pick one of `options` (`select`), yes or no (`confirm`),
 * one line of text (`input`) or several lines (`editor`).
 */
export type QuestionKind = "ask" | "select" | "confirm" | "input" | "editor";

export type QuestionOutcome = "answered" | "skipped" | "timed_out" | "cancelled";

/**
 * Chat extension: the agent waits for the user to answer. Answered with a `chat.ask_response` input
 * item. While `status` is `in_progress` the question is open; once it ends, `outcome` and `answers`
 * say what happened, and the item stays in the thread as a record.
 */
export interface AskRequestItem {
    id: string;
    type: "chat.ask_request";
    status: ItemStatus;
    kind: QuestionKind;
    /** One entry for every kind except `ask`, which can carry several (answered in order). */
    questions: Question[];
    /** Free text is accepted besides the options. Always true for `ask`, `input` and `editor`. */
    allow_free_text: boolean;
    /** Body text of a `confirm`. */
    message?: string;
    /** Placeholder of an `input`. */
    placeholder?: string;
    /** Starting text of an `editor`. */
    prefill?: string;
    /** The runtime stops waiting after this many ms: `ask` then takes the recommended options. */
    timeout_ms?: number;
    /** Epoch ms when the timeout ends. */
    expires_at?: number;
    /** The `function_call` that asked, when the question came from a tool. */
    call_id?: string;
    outcome?: QuestionOutcome;
    answers?: QuestionAnswer[];
}

/**
 * Chat extension: the user's answer to a `chat.ask_request`. Send `skip: true` to skip every
 * unanswered question (the agent continues without them); otherwise one answer per question, in
 * question order. A `confirm` is answered with `selected: ["Yes"]` or `["No"]`; `input` and `editor`
 * with `text`.
 */
export interface AskResponseItem {
    type: "chat.ask_response";
    ask_request_id: string;
    answers?: QuestionAnswer[];
    skip?: boolean;
}

/** Text the agent receives for a skipped question. History uses it to show the question as skipped. */
export const SKIPPED_ANSWER_TEXT = "(No answer: the user skipped this question.)";

/** Chat extension: a context compaction marker in history. */
export interface CompactionItem {
    id: string;
    type: "chat.compaction";
    summary: string;
}

/**
 * Chat extension: why a response ended before it completed. The server adds it as the last output item of a
 * failed, stopped or cut-off response, and history derives it from the stored assistant message, so the thread
 * shows the same note live and after a reload. The client also adds one locally when a send is rejected before a
 * response starts.
 */
export interface RunEndItem {
    id: string;
    type: "chat.run_end";
    status: "failed" | "cancelled" | "incomplete";
    /** Machine-readable reason, for example `stopped`, `agent_exited`, `model_not_allowed` or a provider code. */
    code: string;
    /** Plain-language explanation for the thread. */
    message: string;
}

export type OutputItem =
    | MessageItem
    | ReasoningItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | ApprovalRequestItem
    | AskRequestItem
    | McpElicitationItem
    | CompactionItem
    | RunEndItem;

export type InputItem =
    | { type: "message"; role: "user"; content: (InputText | InputImage | InputFile)[] }
    | ApprovalResponseItem
    | AskResponseItem
    | McpElicitationResponseItem;

// Response object

export type ResponseStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";

export interface Usage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
    /** Chat extension: tokens in the context window after the response's last model call. */
    context_tokens?: number;
}

export interface ResponseObject {
    id: string;
    object: "response";
    created_at: number;
    status: ResponseStatus;
    model: string;
    conversation: { id: string };
    output: OutputItem[];
    usage?: Usage;
    error?: { code: string; message: string } | null;
    /** Chat extension: wall time of the run in ms, for "Worked for 1m 37s". */
    duration_ms?: number;
    /** Chat extension: a slash command answered locally by the agent runtime; its output is not kept in history. */
    local?: boolean;
}

// Client -> server

export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What a turn may ask for: a fixed effort, or "auto", where the runtime picks an effort for each message from its
 * difficulty. "auto" is valid for any model with at least one effort (`ModelInfo.efforts` non-empty); it is not a
 * member of `efforts`, which lists magnitudes only.
 */
export type ThinkingSelector = ThinkingEffort | "auto";
export const thinkingSelectors = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ResponseCreateEvent {
    type: "response.create";
    /** Client-chosen id echoed on every event of this response (optional). */
    event_id?: string;
    stream_id?: string;
    /** Existing conversation; omit to create one. */
    conversation?: string;
    model?: string;
    reasoning?: { effort?: ThinkingSelector };
    input: InputItem[] | string;
    metadata?: {
        project_id?: string;
        permission?: "default" | "full";
        /** Client-side optimistic id for a new conversation, echoed in chat.conversation.created. */
        client_conversation_id?: string;
        /** Create the new conversation as a temporary chat. Ignored for existing conversations and projects. */
        temporary?: boolean;
        /** Start the new conversation with this agent (agents.ts reference). Ignored for existing conversations. */
        agent_id?: string;
        /**
         * Send this message as a new version of the user message with this item id (docs/spec/thread-branching.md
         * section 6). The new version replaces it on the active path; the old version is kept. Existing
         * conversations only.
         */
        edit_of?: string;
    };
}

export interface ResponseCancelEvent {
    type: "response.cancel";
    response_id?: string;
    conversation?: string;
}

/** Ask for the live state of a conversation (after reconnect or opening a running chat). */
export interface ChatResumeEvent {
    type: "chat.resume";
    conversation: string;
}

export type ClientEvent = ResponseCreateEvent | ResponseCancelEvent | ChatResumeEvent;

// Server -> client

interface Base {
    sequence_number: number;
    stream_id?: string;
    /** Per-user counter on application events (not response events); see ChatHelloEvent. */
    app_seq?: number;
}

/** Fields of a conversation that changed without the user's hand (see `chat.conversation.updated`). */
export interface AgenticChange {
    title?: true;
    icon?: true;
}

export interface ConversationSummary {
    id: string;
    title: string;
    projectId: string | null;
    model: string;
    pinnedAt: number | null;
    archivedAt: number | null;
    createdAt: number;
    updatedAt: number;
    /** A response is currently running. */
    active?: boolean;
    /** Temporary chat: never listed, no memory, deleted when the user leaves it (agent.temporaryChats.*). */
    temporary?: boolean;
    /**
     * URL slug from the title (docs/spec/chat-urls.md). Build paths with conversationPath (chat-urls.ts).
     * The server always sends it; optional so summaries built on the client (search hits) still type-check.
     */
    slug?: string;
    /** Short id from the UUID's random tail, unique per user. Null until the server backfills the row. */
    shortId?: string | null;
    /**
     * Chat icon: one emoji or `icon:<Name>` (chat-icons.ts), null when the chat has none. Optional so older
     * servers and client-built summaries still type-check; read it with parseChatIcon.
     */
    icon?: string | null;
    /** "user" when the user chose or removed the icon: automatic choices never replace it. */
    iconSource?: "auto" | "user";
    /**
     * The chat this one was forked from (branching.ts). Absent for chats that are not forks. The source may
     * since have been deleted; read its summary with `GET /api/conversations/:id` and expect a 404.
     */
    forkedFrom?: string;
    /** The agent this chat was started with (agents.ts reference). Absent for plain chats. It may since be deleted. */
    agentId?: string;
    /**
     * Plain-text start of the last assistant reply, at most 200 characters. Shown by the sidebar's expanded rows.
     * Absent until the chat finishes a turn. A generated summary can fill the same field later.
     */
    snippet?: string;
    /** A turn of this chat carried an image or an uploaded file. Absent when none did. */
    hasAttachments?: true;
}

/** How often an open temporary chat tells the server it is still being viewed (POST .../keepalive). */
export const TEMPORARY_KEEPALIVE_MS = 60_000;

export type ServerEvent = Base &
    (
        | { type: "response.created" | "response.in_progress"; response: ResponseObject }
        | {
              type: "response.completed" | "response.failed" | "response.incomplete" | "response.cancelled";
              response: ResponseObject;
          }
        | {
              type: "response.output_item.added" | "response.output_item.done";
              response_id: string;
              output_index: number;
              item: OutputItem;
          }
        | {
              type: "response.output_text.delta";
              response_id: string;
              item_id: string;
              output_index: number;
              content_index: number;
              delta: string;
          }
        | {
              type: "response.output_text.done";
              response_id: string;
              item_id: string;
              output_index: number;
              content_index: number;
              text: string;
          }
        | {
              type: "response.reasoning_text.delta";
              response_id: string;
              item_id: string;
              output_index: number;
              content_index: number;
              delta: string;
          }
        | {
              type: "response.reasoning_text.done";
              response_id: string;
              item_id: string;
              output_index: number;
              content_index: number;
              text: string;
          }
        | {
              type: "response.function_call_arguments.delta";
              response_id: string;
              item_id: string;
              output_index: number;
              delta: string;
          }
        | {
              type: "chat.function_call_output.delta";
              response_id: string;
              item_id: string;
              output_index: number;
              output: string;
              /** Latest subagent state for a `task` call; replaces the item's `subagents`. */
              subagents?: SubagentRun[];
          }
        | {
              /** MCP progress for a running tool call (relayed by the MCP gateway). `total` may be absent. */
              type: "chat.tool_progress";
              response_id: string;
              item_id: string;
              progress: number;
              total?: number;
              message?: string;
          }
        | { type: "chat.conversation.created"; conversation: ConversationSummary; client_conversation_id?: string }
        /**
         * `agentic` names the fields the server or the agent changed on its own (a generated title or icon, or the
         * conversations MCP tools). Absent for the user's own changes. Clients animate those fields only.
         */
        | { type: "chat.conversation.updated"; conversation: ConversationSummary; agentic?: AgenticChange }
        | { type: "chat.conversation.deleted"; conversation_id: string }
        /** The user's model or command listing changed (background refresh); refetch GET /api/models and /api/commands. */
        | { type: "chat.models.updated" }
        | ChatHelloEvent
        | ChatSyncEvent
        /**
         * The conversation's prompt waits for a free agent process (every slot runs a response). `position` is 1 for
         * the next prompt to start. Sent when it joins the queue and whenever its position changes; `null` when it
         * left the queue (started, stopped, timed out). A start is also announced by `response.created`. A prompt
         * that finds a free slot sends no queue event.
         */
        | { type: "chat.queue"; conversation_id: string; position: number | null }
        | { type: "chat.notice"; level: "info" | "warning" | "error"; message: string; conversation_id?: string }
        | { type: "error"; status: number; error: { type: string; code: string; message: string; param?: string } }
    );
