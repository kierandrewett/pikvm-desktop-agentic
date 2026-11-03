# App shell notices (lib/sw-register.ts).

app-update-message = A new version of Chat is ready
app-update-action = Reload

# Notifications (lib/notify.ts).

notify-untitled = New chat
notify-reply-body = The reply is ready.
notify-failure-body = The reply did not finish.
notify-input-body = This chat is waiting for you.
notify-hidden-title = Chat
notify-hidden-body = A chat has news.
notify-open = Open

## Shell (components/shell/*).

shell-sidebar-open = Open sidebar
shell-sidebar-close = Close sidebar
shell-sidebar = Sidebar
shell-sidebar-resize = Resize sidebar
shell-nav-label = App navigation
shell-dest-chats = Chats
shell-dest-files = Files
shell-dest-memory = Memory
shell-dest-agents = Agents
shell-search-everything = Search everything
shell-settings = Settings
shell-apps-failed = Apps did not load. Retry

## Header (components/header/*, components/thread/home-header.tsx).

header-title-temporary = Temporary chat
header-title-new = New chat
header-new-chat = New chat
header-panel-open = Open side panel
header-panel-close = Close side panel
header-rename = Rename
# $title is the chat title (user content).
header-rename-chat = Rename chat: { $title }
# $title is the chat title (user content).
header-actions-for = Chat actions for { $title }
header-actions = Chat actions
header-toolbar = Chat

## Menus and sheets (components/ui/menu.tsx, sheet.tsx).

ui-sheet-default-title = Menu
# $name is the submenu name.
ui-menu-back = Back from { $name }

## Temporary chats (components/temporary/*).

temporary-chat = Temporary chat
temporary-indicator = Temporary
temporary-turn-on = Turn on temporary chat
temporary-turn-off = Turn off temporary chat
temporary-about = About temporary chats
# $when is a phrase from temporary-when-*.
temporary-summary = It won't appear in your history, use or update memory, and is deleted { $when }.
temporary-history-title = Not in your history
temporary-history-body = Kept out of the sidebar, search, Files and other chats.
temporary-memory-title = No memory
temporary-memory-body = Nothing is recalled or remembered, and it gets no title.
# $when is a phrase from temporary-when-*.
temporary-deleted-title = Deleted { $when }
temporary-deleted-body-timed = Files and uploads too, or after that long idle.
temporary-deleted-body-leave = Files and uploads too, also soon after the tab closes.
temporary-still-applies = Custom instructions and connected tools still apply.
temporary-when-leave = when you leave
temporary-when-days =
    { $count ->
        [one] a day after you leave
       *[other] { $count } days after you leave
    }
temporary-when-hours =
    { $count ->
        [one] an hour after you leave
       *[other] { $count } hours after you leave
    }

## Toasts and undo (components/ui/toast.tsx, undo.ts).

# $shortcut is a key combination.
ui-toast-region = Notifications ({ $shortcut })
ui-toast-dismiss = Dismiss notification
ui-undo = Undo
ui-undo-nothing = Nothing was undone

## Page titles (lib/document-title.ts and its callers).

# $page is the page title, $name the instance name.
document-title = { $page } - { $name }
# $section is the settings page name.
title-settings-section = { $section } - Settings
title-admin-section = { $section } - Admin
title-settings-search = Search settings
