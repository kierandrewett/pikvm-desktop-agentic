# Chat sidebar: the account menu (user-menu.tsx), the chat list, chat menu, overlays and date groups.
# $name is the person's display name, or their email address when they have no name.

## Account menu

sidebar-account-menu-title = Account
sidebar-account-menu-label = Account menu for { $name }
sidebar-account-settings-label = Account settings for { $name }
sidebar-admin-badge = Admin

sidebar-appearance = Appearance
sidebar-mode = Mode
sidebar-mode-system = System
sidebar-mode-light = Light
sidebar-mode-dark = Dark
sidebar-theme = Theme
sidebar-more-themes = More themes
sidebar-appearance-settings = Appearance settings

sidebar-memory = Memory
sidebar-full-access = Full access
sidebar-speech = Speech
sidebar-read-aloud-voice = Read-aloud voice

sidebar-settings = Settings
sidebar-admin = Admin
sidebar-sign-out = Sign out

sidebar-setting-save-failed = Could not save setting

## Chat list (components/sidebar/sidebar.tsx, chat-row.tsx, project-group.tsx)

# Shown in place of a chat title before the chat has one.
sidebar-untitled-chat = New chat
sidebar-new-chat = New chat
sidebar-chat-history = Chat history
sidebar-section-pinned = Pinned
sidebar-section-projects = Projects
sidebar-section-chats = Chats
sidebar-new-project = New project
sidebar-projects-error = Could not load projects
sidebar-chats-error = Could not load your chats
sidebar-chats-empty = No chats yet
sidebar-chats-empty-hint = Start a chat with New chat above.
sidebar-chats-all-sorted = All chats are pinned or in projects
sidebar-chats-all-sorted-hint = Open a chat from those sections.
sidebar-search-chats = Search chats
sidebar-show-less = Show less
sidebar-show-more = Show more
# $count is the number of chats that are hidden.
sidebar-show-more-count = Show more ({ $count })
sidebar-chat-title = Chat title
sidebar-chat-actions = Chat actions
sidebar-pin-chat = Pin chat
sidebar-unpin-chat = Unpin chat
sidebar-responding = Responding
sidebar-no-match-pinned = No pinned chats match this view
sidebar-no-match-projects = No projects match this view
sidebar-no-match-chats = No chats match this view
sidebar-view-reset = Reset view

## Filter

sidebar-filter-chats = Filter chats
sidebar-filter-close = Close filter
sidebar-filter-clear-action = Clear filter
# $query is the text in the filter field.
sidebar-filter-empty-title = No chat titles match "{ $query }"
sidebar-filter-empty-description = The filter checks chat titles only.
# Spoken to screen readers. $count is the number of chats that match.
sidebar-filter-status =
    { $count ->
        [one] { $count } chat
       *[other] { $count } chats
    }

## Projects

# $name is a project name.
sidebar-project-new-chat = New chat in { $name }
sidebar-project-new-chat-menu = New chat in project
sidebar-project-actions = Project actions for { $name }
sidebar-project-empty = No chats in this project yet
sidebar-project-fallback-name = project
sidebar-rename-project = Rename project
sidebar-delete-project = Delete project

## Date groups and other groups

# $count is 7 or 30.
sidebar-group-previous-days =
    { $count ->
        [one] Previous { $count } day
       *[other] Previous { $count } days
    }
sidebar-group-no-project = No project
sidebar-group-unknown-model = Unknown model

## Chat menu

sidebar-menu-rename = Rename
sidebar-menu-change-icon = Change icon
sidebar-menu-pin = Pin
sidebar-menu-unpin = Unpin
sidebar-menu-move-to-project = Move to project
sidebar-menu-new-project = New project
sidebar-menu-remove-from-project = Remove from project
sidebar-menu-fork = Fork chat
sidebar-menu-download-markdown = Download as Markdown
sidebar-menu-copy-markdown = Copy as Markdown
sidebar-menu-archive = Archive
sidebar-menu-delete = Delete
sidebar-menu-copied = Chat copied as Markdown
sidebar-menu-copy-failed = Could not copy the chat
# $status is an HTTP status code.
sidebar-menu-server-answered = The server answered { $status }

## Section view menu

sidebar-sort-by = Sort by
sidebar-sort-activity = Last activity
sidebar-sort-created = Date created
sidebar-sort-title = Title
sidebar-sort-pinned = Date pinned
sidebar-sort-manual = Manual order
sidebar-sort-count = Chat count
sidebar-sort-manual-hint = Drag rows, or press Alt and an arrow key on a focused row.
sidebar-direction-a-z = A to Z
sidebar-direction-z-a = Z to A
sidebar-direction-fewest = Fewest chats first
sidebar-direction-most = Most chats first
sidebar-direction-oldest = Oldest first
sidebar-direction-newest = Newest first
sidebar-group-by = Group by
sidebar-group-none = No grouping
sidebar-group-date = Date
sidebar-group-project = Project
sidebar-group-model = Model
sidebar-filter = Filter
sidebar-filter-attachments = Has attachments
sidebar-filter-model = Model
# $name is a model name; $count is the number of chats that use it.
sidebar-filter-model-count = { $name } ({ $count })
sidebar-filter-date = Date
sidebar-filter-agent = Agent
sidebar-filter-no-agent = No agent
sidebar-filter-clear = Clear filters
sidebar-range-any = Any time
sidebar-range-day = Past 24 hours
sidebar-range-week = Past 7 days
sidebar-range-month = Past 30 days
sidebar-range-year = Past year
sidebar-show = Show
sidebar-limit-all = All
sidebar-section-show = Show section
sidebar-section-hide = Hide section
# $title is a section name (Pinned, Projects or Chats).
sidebar-view-options = View options for { $title }
sidebar-view-options-changed = View options for { $title }, changed
sidebar-view-title = { $title } view

## Dialogs

sidebar-delete = Delete
sidebar-cancel = Cancel
sidebar-save = Save
sidebar-create-project = Create project
sidebar-delete-chat-title = Delete chat?
# <name></name> is the chat title in bold.
sidebar-delete-chat-description = This will delete <name></name>. You can undo it for a few seconds.
sidebar-delete-project-title = Delete project?
# <name></name> is the project name in bold.
sidebar-delete-project-description = This will delete <name></name>. Its chats are kept and move to Chats.
sidebar-project-name = Project name
sidebar-project-name-placeholder = For example: Birthday party planning

## Toasts and undo for chats and projects

sidebar-chat-renamed = Chat renamed
sidebar-chat-pinned = Chat pinned
sidebar-chat-unpinned = Chat unpinned
sidebar-chat-archived = Chat archived
sidebar-chat-unarchived = Chat unarchived
sidebar-chat-deleted = Chat deleted
# $project is a project name.
sidebar-chat-moved = Moved to { $project }
sidebar-chat-removed = Removed from { $project }
sidebar-project-created = Project created
sidebar-project-renamed = Project renamed
sidebar-project-deleted = Project deleted
sidebar-error-update-chat = Could not update chat
sidebar-error-rename-chat = Could not rename chat
sidebar-error-pin = Could not pin chat
sidebar-error-unpin = Could not unpin chat
sidebar-error-move = Could not move chat
sidebar-error-archive = Could not archive chat
sidebar-error-unarchive = Could not unarchive chat
sidebar-error-delete-chat = Could not delete chat
sidebar-error-create-project = Could not create project
sidebar-error-rename-project = Could not rename project
sidebar-error-delete-project = Could not delete project
sidebar-undo-rename = Could not undo the rename
sidebar-undo-pin = Could not undo the pin
sidebar-undo-unpin = Could not undo the unpin
sidebar-undo-move = Could not undo the move
sidebar-undo-archive = Could not undo the archive
sidebar-undo-archive-again = Could not archive the chat again
sidebar-undo-new-project = Could not undo the new project
sidebar-undo-chat-changed = The chat changed after this, so it was left as it is.
sidebar-undo-project-changed = The project changed after this, so it was left as it is.
sidebar-undo-project-has-chats = Chats were added to it, so it was kept.
