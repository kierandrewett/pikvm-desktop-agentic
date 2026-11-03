# Conversation thread: turns, activity, side panel (components/thread/).

## Turn

thread-copied = Copied
thread-copy = Copy
thread-copy-message = Copy message
thread-read-aloud = Read aloud
thread-read-aloud-stop = Stop
thread-assistant-said = Assistant said:
thread-you-said = You said:
thread-thinking = Thinking
thread-stopping = Stopping…
thread-queued =
    { $position ->
        [one] Waiting for an available worker
       *[other] Waiting for an available worker, { $position } in the queue
    }
thread-try-again = Try again
thread-context-compacted = Context compacted
thread-day-today = Today
thread-day-yesterday = Yesterday
thread-run-stopped = Stopped
thread-run-cut-off = Response cut off

## Failures

thread-failure-generic = The response failed.
thread-failure-details = Details
thread-failure-hide-details = Hide details
thread-failure-overloaded = The model is overloaded
thread-failure-overloaded-hint = The provider is busy right now. Try again in a moment.
thread-failure-rate-limit = Rate limit reached
thread-failure-rate-limit-hint = Wait a moment, then try again.
thread-failure-rejected = The provider rejected the request
thread-failure-rejected-hint = Check the API key for this provider in Model providers settings.
thread-failure-too-long = This chat is too long for the model
thread-failure-too-long-hint = Start a new chat, or choose a model with more context.
thread-failure-unavailable = The model is not available
thread-failure-unavailable-hint = Choose another model, then try again.
thread-failure-provider = The model provider had a problem
thread-failure-provider-hint = Try again in a moment.
thread-failure-unreachable = Could not reach the model provider
thread-failure-unreachable-hint = Check the connection, then try again.
thread-recovery-model-not-allowed = Choose another model, then try again.
thread-recovery-conversation-busy = Wait for the current response to finish, or stop it, then try again.
thread-recovery-process-limit = Stop another running chat, or try again in a moment.
thread-recovery-sandbox-unavailable = The agent could not start. Try again, or ask an admin to check the server.
thread-recovery-timeout = Check your connection, then try again.

## Side panel

thread-panel-back = Back
thread-panel-view = Side panel view
thread-panel-files = Files
thread-panel-sources = Sources
thread-panel-memories = Memories
thread-panel-subagents = Subagents
# $id is the subagent's name
thread-panel-subagent = Subagent { $id }
thread-panel-files-in-chat = Files in chat
thread-panel-folder = Folder
thread-panel-folder-empty = This folder is empty
thread-panel-files-empty = No files in this chat yet
# Files tab groups: uploads attached to the chat, then the chat's own workspace folder.
thread-panel-attached = Attached
thread-panel-chat-folder = Chat folder
thread-panel-attachment = Attachment
thread-panel-files-error = Could not list these files.
thread-panel-loading = Loading...

## Activity: live header

# $name is a command, file name or host
thread-act-running-named = Running { $name }
thread-act-running-command = Running a command
thread-act-editing-named = Editing { $name }
thread-act-editing-file = Editing a file
thread-act-reading-named = Reading { $name }
thread-act-reading-files = Reading files
thread-act-reading-page = Reading a page
thread-act-searching-files = Searching files
thread-act-searching-web = Searching the web
thread-act-using-browser = Using the browser
thread-act-running-subagents =
    { $count ->
        [one] Running a subagent
       *[other] Running { $count } subagents
    }
thread-act-starting-subagents = Starting subagents
thread-act-updating-plan = Updating the plan
# $name is a tool name
thread-act-using-named = Using { $name }
thread-act-waiting-approval = Waiting for approval
thread-act-thinking = Thinking
thread-act-thought = Thought

## Activity: group summary (joined with commas, first letter capitalised)

thread-act-sum-plan = updated the plan
thread-act-sum-asked =
    { $count ->
        [one] asked a question
       *[other] asked { $count } questions
    }
thread-act-sum-ran =
    { $count ->
        [one] ran a command
       *[other] ran { $count } commands
    }
thread-act-sum-edited =
    { $count ->
        [one] edited a file
       *[other] edited { $count } files
    }
thread-act-sum-read-files =
    { $count ->
        [one] read a file
       *[other] read { $count } files
    }
thread-act-sum-read-pages =
    { $count ->
        [one] read a page
       *[other] read { $count } pages
    }
thread-act-sum-subagents =
    { $count ->
        [one] ran a subagent
       *[other] ran { $count } subagents
    }
thread-act-sum-searched-files = searched files
thread-act-sum-searched-web = searched the web
thread-act-sum-browser = used the browser
# $name is a tool name
thread-act-sum-tool = used { $name }
thread-act-sum-tools = used { $count } tools
thread-act-sum-thought = thought
thread-act-sum-worked = worked

## Activity: steps

thread-act-verb-running = Running
thread-act-verb-ran = Ran
thread-act-verb-writing = Writing
thread-act-verb-wrote = Wrote
thread-act-verb-editing = Editing
thread-act-verb-edited = Edited
thread-act-verb-listing = Listing
thread-act-verb-listed = Listed
thread-act-verb-reading = Reading
thread-act-verb-read = Read
thread-act-verb-searching = Searching for
thread-act-verb-searched = Searched for
thread-act-verb-using = Using
thread-act-verb-used = Used
thread-act-failed = Failed
thread-act-stopped = Stopped
thread-act-exit = exit { $code }
thread-act-exit-code = Exit code { $code }
thread-act-output = Output
thread-act-no-output = No output.
thread-act-error = Error
thread-act-changes = Changes
thread-act-result = Result
thread-act-file = File
thread-act-matches-label = Matches
# $name is a file name
thread-act-lines-changed = { $added } lines added, { $removed } removed
thread-act-lines =
    { $count ->
        [one] { $count } line
       *[other] { $count } lines
    }
thread-act-entries =
    { $count ->
        [one] { $count } entry
       *[other] { $count } entries
    }
thread-act-matches =
    { $count ->
        [one] { $count } match
       *[other] { $count } matches
    }
thread-act-asked = Asked
thread-act-questions =
    { $count ->
        [one] { $count } question
       *[other] { $count } questions
    }
thread-act-answered-of = { $answered } of { $total } answered
thread-act-approved = Approved
thread-act-denied = Denied
thread-act-not-answered = Not answered
thread-act-progress-of = { $value } of { $max }
thread-act-progress-step = Step { $step }
thread-act-tool-progress = Tool progress
thread-act-command = Command
thread-act-command-lower = command
# $command is the slash command that ran
thread-act-command-output = { $command } output
thread-act-command-output-default = Command output

## Questions and elicitation

thread-question-waiting = Waiting for your answer
thread-question-asked = Asked:
thread-question-then = then
thread-question-skipped = Skipped
thread-question-timed-out = No answer in time, chose
thread-question-nothing = nothing
thread-question-none = none
thread-question-stopped = Stopped before an answer
thread-elicit-waiting = Waiting for your input
thread-elicit-answered = Answered
thread-elicit-declined = Declined
thread-elicit-dismissed = Dismissed
# $server is the connector's name
thread-elicit-asked-link = { $server } asked for a link
thread-elicit-asked-input = { $server } asked for input

## Context tab

thread-panel-context = Context
thread-context-window = Context window
thread-context-none = No usage recorded for this chat yet. It shows after the first reply.
# $tokens is a formatted number
thread-context-used = { $tokens } tokens in use
# $used and $window are formatted numbers
thread-context-of = { $used } of { $window } tokens
thread-context-window-unknown = The context window of this model is not known.
thread-context-model = Model
thread-context-model-unset = Picked when you send the first message
thread-context-loading = Loading
thread-context-provider = Provider
thread-context-effort = Thinking effort
thread-context-window-size = Context window
thread-context-tokens = { $tokens } tokens
thread-context-summary = Summary of earlier messages
thread-context-summary-note = Chat works from this summary instead of the older messages.
thread-context-show-less = Show less
thread-context-show-all = Show all

## Sources

thread-sources-cited = Cited in answers
thread-sources-other = Other sources
thread-sources-filter = Filter sources
thread-sources-clear-filter = Clear source filter
thread-sources-clear = Clear filter
thread-sources-no-match = No matching sources
thread-sources-no-match-hint = Try a different title or website.
thread-sources-none = No sources yet
thread-sources-none-hint = Sources appear when this chat searches or reads web pages.
thread-sources-new-tab = (opens in a new tab)
thread-sources-button-label =
    { $count ->
        [one] Sources, { $count } site
       *[other] Sources, { $count } sites
    }

## Selection toolbar

thread-selection-toolbar = Selected text
thread-selection-quote = Quote
thread-selection-quote-title = Quote in your reply
thread-selection-copy-title = Copy the selected text
thread-selection-copy-failed = Could not copy
thread-selection-ask = Ask about this
thread-selection-ask-title = Ask about the selected text
# Text added to the composer after the quoted selection
thread-selection-ask-prompt = Can you explain this?
thread-selection-remember = Remember
thread-selection-remember-title = Save the selected text as a memory
thread-selection-saved = Saved to memory
thread-selection-remove-failed = Could not remove the memory
thread-selection-save-failed = Could not save the memory

## Memories tab

thread-mem-temporary = Memory is off in temporary chats
thread-mem-temporary-hint = Chat does not save or use memories here.
thread-mem-off = Memory is off
thread-mem-off-hint = Chat does not save or use memories while memory is off.
thread-mem-empty = Nothing remembered in this chat yet
thread-mem-empty-hint = Memories show here when Chat saves something from this chat, or uses a saved memory to answer.
thread-mem-settings = Memory settings
thread-mem-all = All memories
# <enable> wraps the link to the memory settings.
thread-mem-off-note = Memory is off. Chat will not save or use memories until you <enable>turn it on</enable>.
thread-mem-saved = Saved in this chat
thread-mem-saved-loading = Loading memories saved in this chat
thread-mem-saved-error = Could not load memories saved in this chat
thread-mem-saved-none = Nothing saved from this chat yet.
thread-mem-show-more = Show more
thread-mem-used = Used in this chat
thread-mem-used-loading = Loading memories used in this chat
thread-mem-used-error = Could not load memories used in this chat
thread-mem-used-only-saved = Only memories saved in this chat were used here.
thread-mem-used-none = No saved memories used in this chat yet.
# $max is the most memories the list shows
thread-mem-used-capped = Showing the { $max } most recently used memories.
# $origin is here, you or saved; $date is a time or a date
thread-mem-saved-caption =
    { $origin ->
        [here] Kept from this chat
        [you] Added by you
       *[saved] Saved by Chat
    } { $date }
# $date is a time or a date
thread-mem-used-caption = Used { $date }
thread-mem-replies =
    { $replies ->
        [one] used in { $replies } reply
       *[other] used in { $replies } replies
    }
thread-mem-replies-plain =
    { $replies ->
        [one] { $replies } reply
       *[other] { $replies } replies
    }
thread-mem-pinned = Pinned.
thread-mem-open = Open in Memory

## Subagents

thread-act-searched-web = Searched the web
thread-sub-status-pending = Waiting
thread-sub-status-running = Running
thread-sub-status-completed = Done
thread-sub-status-failed = Failed
thread-sub-status-cancelled = Stopped
# $name is a tool name
thread-sub-used-named = Used { $name }
thread-sub-sources =
    { $count ->
        [one] { $count } source
       *[other] { $count } sources
    }
thread-sub-waiting-start = Waiting to start
thread-sub-starting = Starting
thread-sub-verb-starting = Starting
# $id is the subagent's name
thread-sub-steps-of = Steps of { $id }
thread-sub-no-steps = No steps yet.
thread-sub-finished = { $id } finished
thread-sub-failed = { $id } failed
thread-sub-stopped = { $id } stopped
thread-sub-progress = { $done } of { $total } finished
thread-sub-n-failed = { $count } failed
thread-sub-n-stopped = { $count } stopped
thread-sub-count =
    { $count ->
        [one] { $count } subagent
       *[other] { $count } subagents
    }
thread-sub-transcript-of = Transcript of { $id }
thread-sub-step-count =
    { $count ->
        [one] { $count } step
       *[other] { $count } steps
    }
thread-sub-show-assignment = Show the full assignment
thread-sub-loading-transcript = Loading the transcript…
thread-sub-transcript-pending = The transcript is not available yet.
thread-sub-transcript-error = Could not load the transcript
thread-sub-none-recorded = No steps were recorded.
thread-sub-loading = Loading subagents…
thread-sub-empty = No subagents in this chat
thread-sub-empty-hint = When the agent splits work across subagents, each one shows here with its progress and transcript.

## Web search

thread-web-results = Search results
thread-web-search = Search
thread-web-failed = This search failed.
thread-web-searching = Searching…
thread-web-stopped = Stopped.
thread-web-no-results = No results.
thread-web-show-more =
    { $count ->
        [one] Show { $count } more result
       *[other] Show { $count } more results
    }
thread-web-queries =
    { $count ->
        [one] { $count } query
       *[other] { $count } queries
    }

## Plan

thread-todo-done = Done
thread-todo-in-progress = In progress
thread-todo-pending = To do
thread-todo-blocked = Blocked
thread-todo-dropped = Dropped
thread-todo-tasks = Tasks
thread-todo-updated = Updated the plan
thread-todo-progress = { $done } of { $total } done

## Question tray

# $option is the recommended option; $seconds is the time left
thread-qt-chooses = Chooses { $option } in { $seconds }s
thread-qt-closes = Closes in { $seconds }s
thread-qt-previous = Previous question
thread-qt-next = Next question
thread-qt-step = { $step } of { $count }
thread-qt-hint-editor = Ctrl+Enter to send, Esc to skip
thread-qt-hint-send-skip = Enter to send, Esc to skip
thread-qt-hint-send-back = Enter to send, Esc to go back
thread-qt-hint-multi = Space to select, Enter to send, Esc to skip
thread-qt-hint-choose = Enter to choose, Esc to skip
thread-qt-skip-rest = Skip the remaining questions
thread-qt-skip-one = Skip the question
thread-qt-recommended = Recommended
thread-qt-other = Something else
thread-qt-your-answer = Your answer
thread-qt-type = Type your answer
thread-qt-skip = Skip
thread-qt-send = Send
thread-qt-continue = Next
thread-qt-region = Question from the assistant

## Approvals and requests for input

thread-appr-hints = Tool hints
thread-appr-deny = Deny
thread-appr-region = Approval needed
thread-appr-destructive = Can change or delete data
thread-appr-read-only = Read only
thread-appr-destructive-badge = Destructive
thread-appr-idempotent = Safe to repeat
thread-appr-open-world = Reaches outside systems
# $name is a tool name
thread-appr-use = Use { $name }?
# $server is the connector's name
thread-appr-use-tool = Use { $server } tool?
thread-appr-run-title = Run this command?
thread-appr-run = Run
thread-appr-edit-title = Edit this file?
thread-appr-allow = Allow
thread-risk-sudo = Runs with administrator rights
thread-risk-rm = Deletes files and cannot be undone
thread-risk-pipe-shell = Downloads and runs a script from the internet
thread-risk-disks = Can overwrite disks or partitions
thread-risk-chmod = Changes permissions recursively
thread-risk-git = Rewrites or discards git history
thread-risk-write-outside = Writes outside the workspace
thread-risk-touch-outside = Touches files outside the workspace
thread-form-required = This field is required.
thread-form-choose-option = Choose one of the options.
thread-form-min-items = Choose at least { $count }.
thread-form-max-items = Choose at most { $count }.
thread-form-number = Enter a number.
thread-form-integer = Enter a whole number.
thread-form-min = Enter { $value } or more.
thread-form-max = Enter { $value } or less.
thread-form-min-length =
    { $count ->
        [one] Enter at least { $count } character.
       *[other] Enter at least { $count } characters.
    }
thread-form-max-length =
    { $count ->
        [one] Enter at most { $count } character.
       *[other] Enter at most { $count } characters.
    }
thread-form-email = Enter an email address.
thread-form-uri = Enter a full address, for example https://example.com.
thread-form-date = Enter a date as YYYY-MM-DD.
thread-form-datetime = Enter a date and time, for example 2026-01-31T09:30:00Z.
thread-form-choose = Choose one
thread-form-none = None
thread-form-punycode = This address uses an encoded domain name (xn--). It can look like a different site. Check it before you open it.
thread-form-unopenable = This address cannot be opened. Only http and https links are allowed.
thread-form-open = Open
thread-form-open-again = Open again
# $server is the connector's name
thread-form-asks = { $server } asks for input
thread-form-cancel = Cancel
thread-form-decline = Decline
thread-form-done = Done
thread-form-submit = Submit
thread-form-region = Input needed

## Attachments, minimap and forks

thread-attach-image = Attached image
thread-attach-open-image = Open attached image
# $name is a file name
thread-minimap-tools = Tool calls
thread-minimap-response = Response
# <source> wraps the link to the source chat.
thread-fork-from = Forked from <source></source>
thread-fork-deleted = Forked from a deleted chat
thread-fork-untitled = New chat

## Conversation page

thread-page-conversation = Conversation
thread-page-reconnecting = Reconnecting...
thread-page-jump-latest = Jump to the latest response
thread-page-scroll-bottom = Scroll to bottom
thread-page-latest = Latest response
thread-page-responding = Assistant is responding
thread-page-complete = Response complete
thread-page-loading = Loading conversation
thread-page-new-chat = Start a new chat
thread-page-not-found = Chat not found
thread-page-not-found-hint = It may have been deleted, or the link is wrong.
thread-page-forbidden = You cannot open this chat
thread-page-load-failed = Could not load this chat
thread-page-empty = No messages yet
thread-page-empty-hint = Send a message to start this chat.

## Home page

thread-home-heading = What can I help with?
# $project is the project's name
thread-home-new-in = New chat in { $project }
thread-home-title = New chat
thread-home-temporary = Temporary chat
thread-home-agent-missing = Agent not found
thread-home-agent-failed = Could not load this agent
thread-home-agent-loading = Loading agent...
thread-home-project-missing = Project not found
thread-home-project-failed = Could not open this project
