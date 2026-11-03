# Custom agents (components/agents, docs/spec/custom-agents.md): the Agents destination, the builder and its
# preview, the agent's home and the agent chip in a chat header.
# "Chat" is the product name. Agent names, descriptions, greetings and starters are user data and are never
# translated. $name is an agent's name.

## Destination and list

agents-title = Agents
agents-title-new = New agent - Agents
agents-title-agent = { $name } - Agents
agents-new = New agent
agents-all = All agents
agents-yours = Your agents
agents-loading = Loading your agents
agents-load-failed = Could not load your agents
agents-empty-title = No agents yet
agents-empty-description = An agent is a saved identity with its own instructions, defaults and tools. Start a chat with it whenever you need it.
agents-empty-action = Create an agent
agents-search = Search agents
agents-search-empty = No agents match "{ $query }".
agents-no-description = No description
agents-edit = Edit
agents-edit-named = Edit { $name }
agents-more-named = More actions for { $name }
# $file is a file name such as "writing-coach.md"; $error is the reason, in English, from the server.
agents-invalid-file = The agent file { $file } could not be read: { $error }

## Delete (with Undo)

agents-delete = Delete agent
agents-delete-description = Chats with this agent stay and go on as normal chats. You can undo for a few seconds.
agents-deleted = Agent deleted
agents-delete-failed = Could not delete the agent
agents-danger = Danger zone

## Missing agent

agents-missing-title = Agent not found
agents-missing-description = It may have been deleted, or the link is wrong.
agents-start-new-chat = Start a new chat

## Builder: header, tabs and saving

agents-untitled = Untitled agent
agents-chat = Chat
agents-chat-start = Start a chat
agents-back = Back to all agents
agents-create = Create
agents-save = Save
agents-unsaved = Unsaved changes
agents-save-failed = Could not save the agent.
agents-conflict = This agent was changed somewhere else after you opened it. Reload to see that version, or keep your changes and save them over it.
agents-conflict-reload = Reload
agents-conflict-keep = Keep mine
agents-discard-title = Discard changes?
agents-discard-description = This agent has changes that are not saved.
agents-discard = Discard

## Builder: identity

agents-picture = Picture
agents-picture-change-label = Change picture
agents-colour = Colour
# $colour is one of: gray, red, orange, yellow, green, teal, blue, purple, pink.
agents-colour-name =
    { $colour ->
        [red] Red
        [orange] Orange
        [yellow] Yellow
        [green] Green
        [teal] Teal
        [blue] Blue
        [purple] Purple
        [pink] Pink
       *[gray] Grey
    }
agents-name = Name
agents-name-placeholder = For example: Writing coach
agents-description-placeholder = For example: Gives blunt, specific feedback on drafts
agents-description = Description

## Builder: behaviour

agents-section-behaviour = Behaviour
agents-instructions = Instructions
agents-instructions-description = What the agent does and how it answers. Your own instructions from Settings still apply; where they conflict, these win.
agents-instructions-placeholder = You are a writing coach. Give direct, specific feedback...
agents-model = Model
agents-model-description = Used for new chats with this agent. Your model access rules still apply.
agents-model-default = Your default model
agents-model-default-description = The default model from your settings
agents-effort = Reasoning effort
agents-effort-default = Your default

## Builder: home screen

agents-section-home = Home screen
agents-section-home-description = What a new chat with this agent shows.
agents-greeting = Greeting
agents-starters = Conversation starters
# $max is the most starters an agent can have.
agents-starters-description = Up to { $max }. A click starts a chat with the text.
agents-starters-placeholder = Add a starter
agents-starters-label = Conversation starters
agents-start-failed = Could not start the chat

## Builder: capabilities

agents-section-capabilities = Capabilities
agents-tools = Tools
agents-tools-all = All my tools
agents-tools-limited = Only these
agents-tools-all-description = The agent can use every tool you have turned on.
agents-tools-limited-description = The agent can use only the tools turned on below.
agents-capability-web = Web search
agents-capability-web-hint = Search the web and read pages.
agents-capability-files = Files and connectors
agents-capability-files-hint = Read and write files. Connectors and chat history need this too.
agents-capability-code = Run commands
agents-capability-code-hint = Run shell commands and code.
agents-capability-ask = Ask you questions
agents-capability-ask-hint = Stop and ask when something is unclear.
agents-capability-todo = To-do list
agents-capability-todo-hint = Plan longer work as a list.
agents-capability-subagents = Helpers
agents-capability-subagents-hint = Hand parts of the work to helper agents.
agents-capability-memory = Memory tools
agents-capability-memory-hint = Save and look up memories on request.
agents-memory = Use my memory
agents-memory-description = Recall what Chat remembers about you in chats with this agent.

## Builder: preview

agents-preview-title = Preview
agents-preview-show = Show preview
agents-preview-hide = Hide preview
agents-preview-chat-label = Preview chat
agents-preview-restart = Start the preview again
agents-preview-failed = Could not start the preview chat
agents-preview-unsaved = The preview chat uses the saved version. Save to try your changes.
agents-preview-unsaved-new = Create the agent to chat with it here.
agents-try-again = Try again

## Pinning and mentioning agents

agents-pin = Pin to sidebar
agents-unpin = Unpin from sidebar
agents-pinned = Pinned to the sidebar
agents-sidebar-pinned = Agents
agents-mention-section = Agents
agents-mention-error = Could not load your agents. Close and reopen this menu to retry.

## Agent chip in a chat header

agents-chip = Agent: { $name }
agents-chip-open = Agent: { $name }. Open agent
agents-chip-deleted = Agent deleted
agents-chip-deleted-hint = This chat's agent was deleted. It goes on as a normal chat.

## Agent picker (home header)

agents-picker-default = Chat
agents-picker-manage = Manage agents
agents-picker-title = Start a chat with
# $name is the agent name.
agents-picker-change = Agent: { $name }. Change agent
agents-picker-choose = Choose an agent
