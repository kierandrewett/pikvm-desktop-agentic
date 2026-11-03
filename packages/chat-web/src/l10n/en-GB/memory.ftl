# Memory destination (components/memory): sidebar, menus, detail panel, editor, memory chat and atlas.
# "Chat" is the product name. Memory text, topic names and chat titles are user data and are never translated.
# $ago is a relative time from Intl.RelativeTimeFormat in the active locale ("today", "3 days ago").
# $date is a date from Intl.DateTimeFormat in the active locale.

## Where a memory came from ($origin: you, chat or saved)

memory-origin-you = Added by you
memory-origin-chat = Kept from a chat
memory-origin-saved = Saved by Chat
memory-origin-when =
    { $origin ->
        [you] Added by you { $ago }
        [chat] Kept from a chat { $ago }
       *[saved] Saved by Chat { $ago }
    }
# <chat> wraps the link to the chat the memory came from.
memory-origin-in-chat =
    { $origin ->
        [you] Added by you in <chat></chat>
        [chat] Kept from a chat in <chat></chat>
       *[saved] Saved by Chat in <chat></chat>
    }
memory-updated-ago = updated { $ago }
memory-life-unused =
    { $origin ->
        [chat] Kept
       *[other] Saved
    } { $date } · Not used in a chat yet
memory-life-used =
    { $origin ->
        [chat] Kept
       *[other] Saved
    } { $date } · Used in { $count ->
        [one] { $count } chat
       *[other] { $count } chats
    }, last { $ago }

## Filters and collections (sidebar names; the page title uses the same words)

memory-collection-all = Everything
memory-filter-pinned = Pinned
memory-filter-recent = Used recently
memory-filter-recalled = Used in chats
memory-filter-never-recalled = Not used yet
memory-filter-chat = Chat excerpts
memory-filter-saved = Saved details
memory-filter-pinned-description = Chat gives these priority.
memory-filter-recent-description = Used in a chat in the last 30 days.
memory-filter-recalled-description = Used in at least one chat.
memory-filter-never-recalled-description = Not used in a chat yet.
memory-filter-chat-description = Kept from your chats for context.

## Sidebar

memory-sidebar-title = Memory
memory-section-topics = Topics
memory-topics-loading = Finding topics...
memory-topics-empty = No topics yet
memory-section-chats = Chats
memory-untitled-chat = Untitled chat
# Name for memories that belong to no topic.
memory-topic-other = Other

## Context menus

memory-menu-open = Open
memory-ask-change = Ask Chat to change this
memory-edit = Edit
memory-pin = Pin
memory-unpin = Unpin
memory-copy-text = Copy text
memory-menu-show-source = Show source chat
memory-menu-show-related = Show related
memory-forget = Forget
memory-menu-ask-topic = Ask Chat about this topic
# Sent to Chat as a message. $topic is a topic name.
memory-topic-question = What do you remember about { $topic }?
memory-menu-pin-all = Pin all
memory-menu-forget-all = Forget all { $count }...
memory-menu-new = New memory
memory-menu-view-list = View as list
memory-menu-view-atlas = View as atlas
memory-menu-sort = Sort by
memory-sort-newest = Newest first
memory-sort-oldest = Oldest first
memory-sort-recalled = Most used
memory-sort-important = Pinned and important first
memory-menu-show-filters = Show filters

## Detail panel

memory-heading = Memory
memory-gone = This memory is gone.
memory-try-again = Try again
memory-close = Close
memory-copy-label = Copy memory text
memory-pin-tooltip = Pin: Chat gives pinned memories priority
memory-pin-label = Pin memory
memory-unpin-label = Unpin memory
memory-edit-label = Edit memory
memory-save = Save
memory-pinned-toast = Memory pinned
memory-unpinned-toast = Memory unpinned
memory-undo-pin-failed = Could not undo the pin
memory-pin-failed = Could not change the pin
memory-updated-toast = Memory updated
memory-undo-edit-failed = Could not undo the edit
memory-changed-since = The memory changed after this, so it was left as it is.
memory-link-untitled-chat = an untitled chat
memory-link-deleted-chat = a deleted chat
memory-used-in = Used in
memory-more-chats =
    { $count ->
        [one] and { $count } more chat
       *[other] and { $count } more chats
    }
memory-related = Related
memory-picked-out = Picked out
memory-forget-confirm-label = Forget this memory?
memory-forget-confirm = Chat will stop using this memory. Chats it came from stay. You can undo for a few seconds.
memory-keep = Keep

## Editor

memory-editor-placeholder = For example: I prefer metric units.
memory-editor-count = { $length } / { $max }
memory-cancel = Cancel

## Memory chat (the panel chat that changes memories)

# The three example buttons are sent to Chat as messages.
memory-chat-example-units = I prefer metric units
memory-chat-example-vegetarian = I'm vegetarian
memory-chat-example-forget-work = Forget where I work
memory-chat-region = Memory chat
# $error is the reason, already a full sentence.
memory-chat-empty-title = Tell Chat something to remember
memory-chat-empty-body = Or ask it to change or forget something it remembers.
memory-chat-delete-failed = Could not delete the memory chat
memory-chat-delete-failed-detail = { $error } The chat stays hidden and expires automatically.
memory-chat-send-failed = Could not send the memory request

## Atlas (the memory map)

memory-map-roledescription = memory map
memory-map-label =
    { $topics ->
        [one] Memory map, { $topics } topic. Arrow keys move between memories, Enter opens one, plus and minus zoom, 0 fits the map.
       *[other] Memory map, { $topics } topics. Arrow keys move between memories, Enter opens one, plus and minus zoom, 0 fits the map.
    }
# Read by screen readers for the focused memory. $topic may be empty.
memory-map-announce = { $summary }. { $topic }. { $originWhen }.
memory-used-times = · used { $count }×
memory-zoom-in = Zoom in
memory-zoom-out = Zoom out
memory-zoom-fit = Fit everything
memory-legend-pinned = Pinned
memory-legend-used-lately = Used lately
memory-legend-from-chat = Kept from a chat
memory-legend-older = Older
memory-legend-bigger = Bigger: used more, or pinned

## Page (memory-page.tsx)

memory-search = Search memories
memory-search-clear = Clear search
memory-view-group = View
memory-view-atlas-short = Atlas
memory-view-list-short = List
memory-view-atlas = Atlas view
memory-view-list = List view
memory-more = More
memory-settings = Memory settings
memory-menu-title = Memories
memory-topic-fallback = Topic
memory-loading = Loading memories
memory-load-failed = Could not load memories
memory-off-title = Memory is off
memory-off-description = Chat does not save or use memories while memory is off. Turn it on in settings.
memory-off-toast-description = Turn on memory in settings before you add or change a memory with Chat.
memory-off-notice = Memory is off. Chat does not save new memories or bring these into chats.
memory-off-chat = Memory is off. Turn it on in memory settings before you use this chat.
memory-turn-on = Turn on
memory-empty-title = Chat has not remembered anything yet
# <q> wraps an example request, shown in quotation marks.
memory-empty-description = Tell Chat something like <q>Remember that I prefer metric units</q> in any chat, or let it pick up details as you talk. Memories show up here, grouped by topic, with the chat each one came from.
# Shown instead of memory-empty-description before the first chat.
memory-empty-description-first-chat = Tell Chat something like <q>Remember that I prefer metric units</q> in any chat, or let it pick up details as you talk. Memories show up here, grouped by topic, with the chat each one came from. You can add one yourself after your first chat.
memory-empty-add = Add a memory
memory-empty-start = Start a chat
memory-forget-failed = Could not forget the memory
memory-forgotten-toast =
    { $count ->
        [one] Memory forgotten
       *[other] { $count } memories forgotten
    }
# Sent to Chat as a message. $text is the memory text.
memory-ask-change-prompt = Change this memory: "{ $text }"
memory-could-not-pin = Could not pin
memory-could-not-unpin = Could not unpin
memory-copied = Copied
memory-copy-failed = Could not copy
memory-forget-topic-title = Forget all of { $topic }?
memory-forget-topic-fallback = Forget topic?
memory-forget-topic-description =
    Chat will forget { $count ->
        [one] { $count } memory
       *[other] { $count } memories
    } in this topic. You can undo for a few seconds.
memory-forget-all-confirm = Forget all

## Panel (memory-panel.tsx)

memory-panel-back = Back
memory-panel-close-label = Close memory panel
memory-panel-chat-title = Memory chat
memory-panel-detail-title = Memory
memory-chat-open-label = Memory chat
memory-chat-open-tooltip = Tell Chat what to remember

## List (memory-list.tsx)

memory-sort-label = Sort
memory-list-no-match = No memories match "{ $query }"
memory-list-empty = No memories here
memory-list-hidden = Other memories may be hidden by the search or a filter.
memory-list-clear = Clear search and filters
memory-list-more = Show more
memory-row-pinned = · pinned

## Phone filters (memory-filters.tsx): the sidebar's topics and chats in a sheet
memory-filters-title = Filters
memory-filters-open = Filters
memory-topics-error = Topics did not load
memory-collection-current = Collection: { $name }
