# Composer attachments, chips and paste (components/composer/).

composer-attachments = Attachments
composer-attachment-uploading = Uploading
composer-attachment-label-uploading = { $name }, uploading
composer-attachment-label-failed = { $name }, failed
composer-upload-failed = Upload failed
composer-upload-no-server = The upload could not reach the server
composer-retry = Try again
composer-retry-named = Try uploading { $name } again
composer-remove = Remove { $name }
composer-remove-chip = Remove { $label }, { $name }
composer-image-too-large = { $name } is larger than 20 MB
composer-image-fallback = The image
composer-chip-added = { $labels } added
composer-chip-removed = { $label } removed
composer-failed-toast-title = An attachment did not upload
composer-failed-toast-body = Try it again or remove it, then send.
composer-resources = Resources

# Send, stop and permission controls (controls.tsx).

composer-send = Send message
composer-stop = Stop
composer-stopping = Stopping…
composer-stop-label = Stop response
composer-stopping-label = Stopping response
composer-permission-default = Default permissions
composer-permission-default-short = Default
composer-permission-default-description = Ask before running commands that change files
composer-permission-full = Full access
composer-permission-full-description = Run any command without asking. The sandbox still applies
composer-permission-label = Permissions: { $name }
composer-permission-header = How should actions be approved?
composer-permission-change = Change permissions

# Add sheet, command sources and MCP servers (attach-sheet.tsx, suggest.tsx, mcp-servers.tsx).

composer-add-sheet-title = Add to your message
composer-add-photos = Photos
composer-add-photos-description = Choose from your library
composer-add-camera = Camera
composer-add-camera-description = Take a photo
composer-add-files = Files
composer-add-photos-files = Add photos & files
composer-add-fullscreen = Write in full screen
composer-add-fullscreen-description = More room, with formatting
composer-upload-from-device = Upload from your device
composer-mention-tool = Mention a tool
composer-server-tools =
    { $count ->
        [one] { $count } tool
       *[other] { $count } tools
    }
composer-server-not-connected = Not connected
composer-server-not-connected-error = Not connected: { $error }
composer-server-whole = The whole server, every tool
composer-mcp-prompts-section = MCP prompts: { $server }
# The name of a menu level, for screen readers ("notes: tools and resources").
composer-menu-server = { $server }: tools and resources
composer-menu-arguments = Options for { $command }
# Said when a menu level opens or the menu goes back to one.
composer-menu-level-opened =
    { $label }, { $count ->
        [one] { $count } option
       *[other] { $count } options
    }
composer-source-app = Chat command
composer-source-agent = Agent command
composer-source-skill = Skill
composer-source-mcp = MCP prompt

# Dictation (dictation.tsx) and MCP servers (mcp-servers.tsx).

composer-dictate = Dictate
composer-dictation-cancel = Cancel
composer-dictation-cancel-label = Cancel dictation
composer-dictation-done = Done
composer-dictation-stop-label = Stop and insert text
composer-dictation-denied = Microphone access was denied.
composer-dictation-no-microphone = No microphone was found.
composer-dictation-error = Dictation stopped because of an error.
composer-mcp-title = MCP servers in this chat
composer-mcp-loading = Loading servers
composer-mcp-error = Could not load servers
composer-mcp-none = No remote servers are set up
composer-mcp-off = MCP servers: { $count } off in this chat

# Thinking effort (effort.tsx, choice.ts).

composer-effort-label = Thinking effort
composer-effort-trigger-label = Thinking effort: { $level }
composer-effort-list = Choose thinking effort from a list
composer-effort-auto = Auto
composer-effort-off = Off
composer-effort-minimal = Minimal
composer-effort-low = Low
composer-effort-medium = Medium
composer-effort-high = High
composer-effort-xhigh = Extra high
composer-effort-max = Max
composer-effort-status-auto = { $level }.
composer-effort-status = { $level }, { $index } of { $total }.
composer-effort-valuetext-auto = { $level }, picks a level per message

# Full-screen editor (fullscreen.tsx, markdown-editor.tsx).

composer-message = Message
composer-editor-label = Full-screen editor
composer-editor-mode = Editor mode
composer-editor-write = Write
composer-editor-preview = Preview
composer-editor-formatting = Formatting
composer-editor-back = Back to the composer
composer-editor-collapse = Collapse to the composer
composer-editor-empty-preview = Nothing to preview yet.
composer-editor-placeholder = Write your prompt in Markdown
composer-editor-tool-bold = Bold
composer-editor-tool-italic = Italic
composer-editor-tool-code = Code
composer-editor-tool-link = Link
composer-editor-tool-bullet = Bulleted list
composer-editor-tool-numbered = Numbered list
composer-editor-tool-quote = Quote
composer-editor-tool-heading = Heading
composer-read-failed = Could not read the file

# Composer menus, confirmations and toasts (composer.tsx).

composer-placeholder = Ask anything
composer-draft-restored = Draft restored
composer-dictation-stopped = Dictation stopped
composer-loading = Loading...
composer-no-match = No match
composer-dismiss = Dismiss
composer-commands = Commands
composer-add-more = Add files and more
composer-add-files-short = Add files
composer-open-editor = Open the full-screen editor
composer-try-again = Try again in a moment.
composer-open-settings = Open Settings
composer-no-models = No models available
composer-no-models-hint = No models available. Add a model provider in Settings to start.
composer-send-failed = Could not send the message
composer-command-failed = The command failed
composer-commands-loading = Commands are still loading
composer-commands-need-chat = Commands run inside a conversation.
composer-start-chat-first = Start a chat first
composer-commands-error = Could not load commands. Close and reopen this menu to retry.
composer-no-commands = No commands
composer-files-error = Could not load files or tools. Close and reopen this menu to retry.
composer-no-files-or-tools = No files or tools
composer-no-tools = No tools
composer-search-footer = Type to search files and tools
composer-section-agent = Agent
composer-section-skills = Skills
composer-section-files = Files
composer-section-mcp = MCP
composer-section-actions = Actions
composer-models-section = Models
composer-model-no-match = No matching model
composer-model-changed = Model changed
composer-applies-to-new = { $name } · applies to new messages
composer-effort-changed = Thinking effort changed
composer-effort-no-match = No matching level
composer-effort-unsupported = This model has no thinking effort
composer-effort-none = No thinking effort
composer-effort-none-detail = { $name } does not support it
composer-permission-section = Permissions
composer-permission-changed = Permissions changed
composer-permission-full-effect = Full access · runs without asking
composer-permission-default-effect = Default · asks before it acts
composer-projects-section = Projects
composer-no-projects = No projects found
composer-new-chat = New chat
composer-new-chat-in-project = New chat in this project
composer-cleared = Composer cleared
composer-cleared-detail = Text and attachments removed
