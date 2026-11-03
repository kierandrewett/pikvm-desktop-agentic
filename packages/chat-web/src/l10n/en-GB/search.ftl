# Search dialog (components/search): the dialog, its scope names, rows, actions and toasts.

## Actions scope

search-action-new-chat = New chat
search-action-hide-sidebar = Hide sidebar
search-action-show-sidebar = Show sidebar
search-action-light-mode = Switch to light mode
search-action-dark-mode = Switch to dark mode
search-action-open-files = Open files
search-action-upload = Upload files
search-action-open-settings = Open settings
search-action-archived = Archived chats

## Result rows

# Shown in place of a chat title before the chat has one.
search-untitled-chat = New chat
search-archived = Archived
# Prefix before an excerpt of a message the person sent.
search-message-you = You:{ " " }
search-uploads = Uploads
search-project = Project
search-memory-saved = Saved memory
search-memory-from-chat = From a chat
# $source is a chat title or one of the two messages above; $time is a relative time ("5 min. ago").
search-memory-meta = { $source } · { $time }
# $query is the text of an earlier search.
search-remove-recent = Remove "{ $query }" from recent searches

## Opening a message from a result

search-message-gone = This message is no longer available.
search-message-open-failed = Could not open this message. Try the search result again.
search-message-show-failed = Could not show this message. Try the search result again.

## Scopes

# Scope names: tabs, group headings and the results list label.
search-scope-all = All
search-scope-chats = Chats
search-scope-messages = Messages
search-scope-files = Files
search-scope-memories = Memories
search-scope-settings = Settings
search-scope-actions = Actions
search-scope-label = Search scope
# $scope is the name of one scope above.
search-results-label = { $scope } results

## Dialog

search-title-chats = Search chats
search-title-all = Search everything
search-placeholder-all = Search everything
search-placeholder-chats = Search chats
search-placeholder-messages = Search messages
search-placeholder-files = Search files
search-placeholder-memories = Search memories
search-placeholder-settings = Search settings
search-placeholder-actions = Type a command
search-cancel = Cancel
search-dismiss = Dismiss
search-instructions = Use the arrow keys to choose a result and Enter to open it. Ctrl+Tab switches the scope. Tab moves between controls.
search-hint-messages = Search the text of every message you have sent or received.
search-hint-files = Search uploads and workspace files by name.
search-hint-memories = Search what Chat remembers about you.

## Groups

search-group-recent-searches = Recent searches
search-group-recent = Recent
search-group-quick-actions = Quick actions
search-group-recent-chats = Recent chats
search-group-suggested = Suggested
search-group-projects = Projects
search-clear-recent = Clear
search-newest-first = Newest first
search-show-all-messages = Show all matching messages
search-show-all-files = Show all matching files
search-show-all-memories = Show all matching memories
search-show-all-settings = Show all matching settings
search-load-more-messages = Load more messages
search-loading = Loading...

## Empty, error and status text

# $query is what the person typed.
search-empty-title = No results for "{ $query }"
search-empty-all = Try fewer or different words.
# $scope is the name of one scope above.
search-empty-scope = Nothing in { $scope }. Other scopes might have it.
search-clear-search = Clear search
# $reason is the reason the search failed, already translated.
search-error-search = Could not search. { $reason }
search-error-memories = Could not search memories. { $reason }
search-retry = Try again
search-retrying = Trying again...
# Spoken to screen readers when results settle. $count is the number of results.
search-announce-results =
    { $count ->
        [one] { $count } result in { $scope }
       *[other] { $count } results in { $scope }
    }
search-announce-none = No results in { $scope }
search-uploading = Uploading...
search-indexing = Indexing older chats...
# $name is a file name; $error is the reason.
search-upload-failed = Could not upload { $name }: { $error }

## Footer key hints

search-key-up = Up
search-key-down = Down
search-key-enter = Enter
search-key-ctrl-tab = Ctrl Tab
search-key-esc = Esc
search-footer-move = move
search-footer-open = open
search-footer-scope = scope
search-footer-close = close

search-scope-agents = Agents
search-placeholder-agents = Search agents
search-show-all-agents = Show all agent matches
