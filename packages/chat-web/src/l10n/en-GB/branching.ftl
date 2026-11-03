# Edit, rewind, fork and message versions in the thread (components/thread/branch-*.ts*, message-versions.tsx).

## Message actions

branch-edit = Edit
branch-rewind = Rewind to here
branch-fork = Fork from here
branch-busy = Wait for the response to finish
# $day is "Today", "Yesterday" or a date; $time is the time of day
branch-sent-at = Sent { $day } { $time }
# The send time of a message from an earlier day, shown in the hover row
branch-time-other-day = { $day }, { $time }

## Inline editor

branch-editor-label = Edit message
branch-editor-hint = Saving sends this as a new version. The current version is kept.
branch-editor-cancel = Cancel
branch-editor-save = Save
branch-edit-failed = Could not send the edited message

## Version switcher

# $index is the version shown, $count is how many versions the message has
branch-versions = Message versions, { $index } of { $count }
branch-version-count = { $index }/{ $count }
branch-version-shown = Version { $index } of { $count }
branch-version-previous = Previous version
branch-version-next = Next version
branch-version-failed = Could not switch to that version

## Fork and rewind notices

branch-fork-failed = Could not fork the chat
branch-forked = Chat forked
branch-fork-untitled = New chat
branch-fork-undo-failed = Could not undo the fork
branch-rewind-failed = Could not rewind the chat
branch-rewound = Rewound
branch-rewound-detail = Later messages were removed from this chat.
branch-rewind-undo-failed = Could not undo the rewind
branch-rewind-undo-changed = New messages were sent after the rewind, so it was left as it is.
