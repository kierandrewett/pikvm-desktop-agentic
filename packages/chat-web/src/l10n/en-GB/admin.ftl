# Admin pages (components/settings/pages/admin*.tsx, components/settings/admin/*).
# Setting labels and descriptions come from the settings registry, not from this file.
# Names, emails and reasons are user content and arrive as variables.

## Shared

admin-cancel = Cancel
admin-loading = Loading...
admin-never = Never
admin-request-failed = Request failed
admin-badge-admin = Admin
admin-badge-you = You
admin-badge-on = On
admin-badge-off = Off
admin-badge-over-quota = Over quota
admin-status-active = Active
admin-role-user = User
admin-role-admin = Administrator
admin-unit-days = days
admin-unit-characters = characters
admin-unit-hours = hours
admin-unit-minutes = minutes
admin-unit-seconds = seconds
admin-users-count =
    { $count ->
        [one] { $count } user
       *[other] { $count } users
    }
admin-agents-count =
    { $count ->
        [one] { $count } agent
       *[other] { $count } agents
    }
admin-storage-unmeasured = Not measured yet
# $used and $quota are file sizes.
admin-storage-of = { $used } of { $quota }
admin-storage-measuring = Measuring storage...
# $when is a relative time such as "3 days ago".
admin-storage-measured = Storage measured { $when }
admin-storage-measure-now = Measure now
admin-storage-measure-toast = Measuring storage. Figures update in a moment.
admin-users-over-quota = Users over quota

## Authentication page

admin-auth-title = Authentication
admin-auth-accounts = Accounts
admin-auth-signup-closed = Admins only
admin-auth-signup-open = Open
admin-auth-email-password = Email and password
admin-auth-passkeys = Passkeys
admin-auth-two-factor = Two-factor authentication
admin-auth-security = Security
admin-auth-profile-pictures = Profile pictures

## Models and policy page

admin-models-title = Models and policy
admin-models-defaults = Defaults
admin-models-access = Model access
admin-models-user-changes = What users can change
admin-models-default-label = Default model
admin-models-tier-standard = Standard
admin-models-tier-flex = Flex
admin-models-tier-priority = Priority
admin-models-preview = Preview
admin-models-preview-description = Checked against the models available to your account.
admin-models-preview-label = Model access preview
admin-models-preview-summary =
    { $total ->
        [one] { $allowed } of { $total } model allowed. Deny patterns win over allow patterns.
       *[other] { $allowed } of { $total } models allowed. Deny patterns win over allow patterns.
    }
admin-models-allowed = Allowed
admin-models-denied = Denied
admin-models-blocked = Not allowed

## Model features

admin-features-title = Model features
admin-features-description = Defaults for features some models handle badly.
admin-features-locked = Model features are managed by the config file.
admin-features-loading = Loading model features...
admin-features-rules = Rules
admin-features-rules-description = Rules that change features for groups of models.
admin-features-models = Models
admin-features-models-description = Select a model to change its features.
admin-features-browse =
    { $count ->
        [one] { $count } model
       *[other] { $count } models
    }
admin-features-browse-open = Browse
admin-features-inherit = Inherit
admin-features-user-toggle = People can turn it off for themselves
admin-features-reset-default = Back to the built-in default
# $feature is the feature name.
admin-features-by-default = { $feature } by default
# $feature is the feature name, $state is "on" or "off".
admin-features-state =
    { $state ->
        [on] { $feature } on
       *[off] { $feature } off
    }
admin-features-no-changes = No changes yet
# $summary is a list of feature states, $count the number of matching models.
admin-features-rule-summary =
    { $count ->
        [one] { $summary }. Matches { $count } model.
       *[other] { $summary }. Matches { $count } models.
    }
admin-features-done = Done
admin-features-edit = Edit
admin-features-remove-rule = Remove rule
# $rule is a glob.
admin-features-remove-rule-named = Remove rule { $rule }
# $feature is the feature name, $target a rule or a model name.
admin-features-for = { $feature } for { $target }
admin-features-no-rules = No rules.
admin-features-no-rules-description = Add a glob such as provider/* to change a group of models.
admin-features-remove-title = Remove rule?
admin-features-remove-description = Models matched by <rule></rule> go back to the next matching rule or the defaults.
admin-features-remove = Remove
admin-features-error-spaces = Rules have no spaces.
admin-features-error-glob = A rule needs a * glob. To change one model, select it under Models.
admin-features-error-default = * on its own is the defaults, above.
admin-features-error-exists = That rule already exists.
admin-features-add-rule = Add a rule
admin-features-add-hint = A glob on provider/model, such as provider/* or */llama-*.
admin-features-matches =
    { $count ->
        [one] Matches { $count } model.
       *[other] Matches { $count } models.
    }
admin-features-pattern = Rule pattern
admin-features-add = Add
admin-features-clear-own = Clear this model's own settings

## Sandbox, system, quotas

admin-sandbox-title = Sandbox
admin-sandbox-isolation = Isolation
admin-sandbox-agents = Agents
admin-sandbox-runtime = Agent runtime
admin-sandbox-label = Sandbox
admin-sandbox-isolated = Isolated
admin-sandbox-none = None
admin-sandbox-off-notice = The sandbox is off. Agents run as the server user with full access to its files, other users' data and the network. Only use this on a trusted single-user install.
admin-sandbox-confirm-title = Turn off the sandbox?
admin-sandbox-confirm-description = Agents will run without isolation. They can read and change every file the server can, including other users' chats and keys. Do this only on a trusted single-user install.
admin-sandbox-confirm-action = Turn off sandbox
admin-system-title = System
admin-system-instance = Instance
admin-system-catalogue = Model catalogue
admin-config-title = Config file
admin-config-description = Values set in config.toml are read-only here.
admin-config-secrets = Include secrets
admin-config-download = Download
admin-config-reload = Reload
admin-config-reloading = Reloading...
admin-config-reload-failed = Reload failed
admin-config-reload-result =
    { $errors ->
        [0] Applied { $applied }, removed { $removed }.
        [one] Applied { $applied }, removed { $removed }, { $errors } error.
       *[other] Applied { $applied }, removed { $removed }, { $errors } errors.
    }
admin-quotas-title = Quotas and storage
admin-quotas-limits = Limits
admin-quotas-limits-description = Defaults for every user.
admin-quotas-temporary = Temporary chats

## Live usage (shown on the Sandbox and Quotas pages)

admin-usage-running-now = Running now
admin-usage-agents-waiting = { $waiting } waiting
admin-usage-agents =
    { $limit ->
        [one] { $running } of { $limit } agent
       *[other] { $running } of { $limit } agents
    }
# $name is a user's name or email, $busiest the number of agents that user runs.
admin-usage-agents-most =
    { $limit ->
        [one] { $running } of { $limit } agent. Most: { $name } ({ $busiest ->
            [one] { $busiest } agent
           *[other] { $busiest } agents
        })
       *[other] { $running } of { $limit } agents. Most: { $name } ({ $busiest ->
            [one] { $busiest } agent
           *[other] { $busiest } agents
        })
    }
admin-usage-title = Usage now
admin-usage-measured = Storage measured { $when }.
admin-usage-unmeasured = Storage is not measured yet.
admin-usage-storage = Storage in use
# $used is a file size or "...".
admin-usage-across =
    { $count ->
        [one] { $used } across { $count } user
       *[other] { $used } across { $count } users
    }
admin-usage-nobody-over = Nobody is over their quota.

## Overview page

admin-overview-title = Overview
admin-overview-load-failed = Could not load the overview
admin-overview-sandbox-notice = The sandbox is off: agents run with the server's access to every user's files.
admin-overview-signup-notice = Sign-up is open: anyone who can reach this instance can create an account.
admin-overview-users = Users
admin-overview-accounts =
    { $count ->
        [one] account
       *[other] accounts
    }
admin-overview-active-7 = active in 7 days
admin-overview-active-30 = active in 30 days
admin-overview-new-30 = new in 30 days ({ $recent } in 7)
admin-overview-admins = Administrators
admin-overview-admins-count =
    { $count ->
        [one] { $count } administrator
       *[other] { $count } administrators
    }
admin-overview-banned = Banned
admin-overview-banned-count =
    { $count ->
        [one] { $count } banned account
       *[other] { $count } banned accounts
    }
admin-overview-banned-none = Nobody is banned.
admin-overview-two-factor = Two-factor authentication
admin-overview-two-factor-usage =
    { $total ->
        [one] { $count } of { $total } account uses it ({ NUMBER($ratio, style: "percent") }).
       *[other] { $count } of { $total } accounts use it ({ NUMBER($ratio, style: "percent") }).
    }
admin-overview-inactive = Inactive accounts
admin-overview-inactive-description = No sign-in or chat for 90 days.
admin-overview-agents = Agents
admin-overview-agents-description = Agent processes running now.
admin-overview-running = { $running } of { $limit } running
admin-overview-at-limit = At the server limit: new chats wait for an agent to stop, or stop the least recently used one.
admin-overview-limit-hint = Server limit from Sandbox settings.
admin-overview-meter = Agent processes running
admin-overview-sandbox = Sandbox and limits
admin-overview-sandbox-off = Sandbox is off.
admin-overview-sandbox-on = Sandbox is on.
admin-overview-storage = Storage
admin-overview-measuring = Measuring now...
admin-overview-measured = Measured { $when }.
admin-overview-unmeasured = Not measured yet.
admin-overview-on-disk = on disk
admin-overview-uploads =
    { $count ->
        [one] in { $count } upload
       *[other] in { $count } uploads
    }
admin-overview-over-quota = over their quota
admin-overview-over-quota-description = They cannot upload or start a turn until they free space.
admin-overview-quotas = Quotas
admin-overview-quotas-description = Default limits for every user.
admin-overview-newest = Newest accounts
admin-overview-all-users = All users
admin-overview-no-accounts = No accounts yet.
admin-overview-joined = joined { $date }
admin-overview-joined-email = { $email } · joined { $date }

## Users list

admin-users-title = Users
admin-users-create = Create user
admin-users-search-label = Search users by name, email or id
admin-users-search-placeholder = Search name, email or id
admin-users-change-failed = Could not change users
admin-users-select-truncated =
    { $total ->
        [one] Selected the first { $count } of { $total } user
       *[other] Selected the first { $count } of { $total } users
    }
admin-users-select-failed = Could not select every matching user
admin-users-matching =
    { $count ->
        [one] { $count } matching user
       *[other] { $count } matching users
    }
admin-users-total =
    { $count ->
        [one] { $count } user
       *[other] { $count } users
    }
admin-users-loading = Loading users...
admin-users-clear-filters = Clear filters
admin-users-all-loaded =
    { $count ->
        [one] The loaded user is selected.
       *[other] All { $count } loaded users are selected.
    }
# $filtered is "yes" when filters are active.
admin-users-select-all =
    { $filtered ->
        [yes]
            { $count ->
                [one] Select the { $count } matching user
               *[other] Select all { $count } matching users
            }
       *[no]
            { $count ->
                [one] Select the { $count } user
               *[other] Select all { $count } users
            }
    }
admin-users-load-failed = Could not load users
admin-users-empty-filtered = No users match these filters.
admin-users-empty = No users yet.
admin-users-selected-label = Selected users
admin-users-selected = { $count } selected
admin-selection-clear = Clear
admin-selection-more = More actions for the selected users
admin-selection-actions = Actions
admin-columns = Columns
admin-columns-choose = Choose columns
admin-column-last-active = Last active
admin-column-chats = Chats
admin-column-storage = Storage
admin-column-joined = Joined
admin-column-two-factor = Two-factor
admin-column-status = Status
admin-sort-label = Sort
admin-sort-name = Name
admin-sort-email = Email
# $sort is a column name.
admin-sort-text-asc = { $sort }, A to Z
admin-sort-text-desc = { $sort }, Z to A
admin-sort-number-asc = { $sort }, oldest or fewest first
admin-sort-number-desc = { $sort }, newest or most first
admin-filter-role = Role
admin-filter-role-any = Any role
admin-filter-role-admin = Administrators
admin-filter-role-user = Users
admin-filter-status = Status
admin-filter-status-any = Any status
admin-filter-status-active = Can sign in
admin-filter-status-banned = Banned
admin-filter-activity = Activity
admin-filter-activity-any = Any activity
admin-activity-7d = Active in 7 days
admin-activity-30d = Active in 30 days
admin-activity-90d = Active in 90 days
admin-activity-dormant = Inactive for 90 days
admin-filter-two-factor = Two-factor
admin-filter-two-factor-any = Any two-factor
admin-filter-two-factor-on = Two-factor on
admin-filter-two-factor-off = Two-factor off
admin-filter-storage = Storage
admin-filter-storage-any = Any storage
admin-filter-storage-over = Over quota
admin-action-open = Open
admin-action-make-user = Make user
admin-action-make-admin = Make administrator
admin-action-set-password = Set password
admin-action-unban = Unban
admin-action-ban = Ban
admin-action-sign-out = Sign out everywhere
admin-action-global-limits = Use global limits
admin-action-delete-user = Delete user
admin-action-delete = Delete

## Users table

# $name is a user's name or email.
admin-table-select = Select { $name }
admin-table-actions-for = Actions for { $name }
admin-table-no-name = No name
admin-table-user = User
admin-table-select-all = Select all loaded users
admin-table-clear-selection = Clear selection
admin-table-loading-more = Loading more users...
# $when is a relative time such as "3 days ago".
admin-table-active = Active { $when }
admin-table-chats =
    { $count ->
        [one] { $count } chat
       *[other] { $count } chats
    }

## Bulk actions (toasts)

admin-bulk-banned =
    { $count ->
        [one] Banned { $count } user
       *[other] Banned { $count } users
    }
admin-bulk-unbanned =
    { $count ->
        [one] Unbanned { $count } user
       *[other] Unbanned { $count } users
    }
admin-bulk-role =
    { $count ->
        [one] Changed the role of { $count } user
       *[other] Changed the role of { $count } users
    }
admin-bulk-signed-out =
    { $count ->
        [one] Signed out { $count } user everywhere
       *[other] Signed out { $count } users everywhere
    }
admin-bulk-limits-reset =
    { $count ->
        [one] Reset the limits of { $count } user
       *[other] Reset the limits of { $count } users
    }
admin-bulk-deleted =
    { $count ->
        [one] Deleted { $count } user
       *[other] Deleted { $count } users
    }
# $done is a message from admin-bulk-*.
admin-bulk-partial =
    { $skipped ->
        [one] { $done }; { $skipped } user skipped
       *[other] { $done }; { $skipped } users skipped
    }
admin-bulk-none = Nothing changed
# $message is the first reason, $more the number of other reasons.
admin-bulk-more-reasons =
    { $more ->
        [one] { $message } (and { $more } more reason)
       *[other] { $message } (and { $more } more reasons)
    }
admin-bulk-undo-failed = Could not undo
# $label is a user's name or email.
admin-delete-one = Deleted { $label }
admin-delete-failed = Could not delete

## Dialogs

admin-password-help =
    { $count ->
        [one] At least { $count } character. Share it with the user over a safe channel.
       *[other] At least { $count } characters. Share it with the user over a safe channel.
    }
admin-password-too-short =
    { $count ->
        [one] Use at least { $count } character.
       *[other] Use at least { $count } characters.
    }
admin-password-generate = Generate
admin-password-show = Show
admin-password-hide = Hide
admin-password-copy = Copy
admin-password-copied = Password copied
admin-password-copy-failed = Could not copy the password
admin-password-new = New password
# $name is a user's name or email.
admin-password-set-title = Set password for { $name }
admin-password-set-description = Their other sessions stay signed in. Sign them out everywhere as well if the old password leaked.
admin-password-set-done = Password set for { $name }
admin-create-done = Created { $name }
admin-create-name = Name
admin-create-name-required = Enter a name.
admin-create-email = Email
admin-create-email-invalid = Enter an email address, for example ada@example.com.
admin-create-password = Password
admin-create-role = Role
admin-create-signup-open = Sign-up is open, so people can also create their own accounts.
admin-create-signup-closed = Sign-up is closed, so only administrators create accounts.
admin-create-change-signup = Change sign-up
admin-create-no-password = Email and password sign-in is off. The user can only sign in with a provider that uses the same email address.
# $what is a user's name or "12 users".
admin-ban-title = Ban { $what }?
admin-ban-description = They are signed out at once, their running agents stop, and they cannot sign in until you unban them. Their chats and files stay.
admin-ban-reason = Reason
admin-ban-reason-help = Only administrators see it.
admin-delete-title = Delete { $what }?
admin-delete-detail = Their account, chats, files, memory and settings are deleted.
admin-delete-warning = You can undo for a few seconds; after that it cannot be undone. To keep the data, ban instead.
# $number is the number to type, as digits.
admin-delete-type = Type { $number } to confirm

## User detail

admin-detail-title = User
admin-detail-load-failed = Could not load this user
admin-detail-change-failed = Could not change the user
admin-detail-email-verified = Email verified
admin-detail-email-unverified = Email not verified
admin-detail-joined = Joined { $date }
admin-detail-access = Access
admin-detail-role-self = You cannot remove your own admin role. Ask another administrator.
admin-detail-role-description = Administrators manage users and every setting on this page.
# $kind is "plain", "reason", "until" or "both"; $reason is user content.
admin-detail-banned =
    { $kind ->
        [reason] Banned: { $reason }.
        [until] Banned until { $until }.
        [both] Banned: { $reason } until { $until }.
       *[plain] Banned.
    }
admin-detail-password-set = Set a new password and share it with the user.
admin-detail-password-none = No password yet. Setting one lets the user sign in with email and password.
admin-detail-sign-in = Sign-in
admin-detail-methods = Sign-in methods
admin-detail-none = None
admin-detail-none-sentence = None.
admin-method-credential = Email and password
admin-detail-two-factor-on = On. The user turns it off from their own account page.
admin-detail-two-factor-off = Off.
admin-detail-passkeys = Passkeys
admin-detail-passkey = Passkey
admin-detail-passkey-dated = { $name } ({ $date })
admin-detail-usage = Usage
admin-detail-no-quota = (no quota)
admin-detail-over-quota = (over quota)
admin-detail-storage-used = Storage used
admin-detail-chats = { $chats ->
        [one] { $chats } chat
       *[other] { $chats } chats
    }, { $archived } archived, { $projects ->
        [one] { $projects } project
       *[other] { $projects } projects
    }
admin-detail-uploads = Uploads
admin-detail-uploads-size =
    { $count ->
        [one] { $count } file, { $size }
       *[other] { $count } files, { $size }
    }
admin-detail-agents = Agents running
admin-detail-agents-allowed = { $running } of { $limit } allowed at once
admin-detail-limits = Limits for this user
admin-detail-limits-description = Values set here replace the global value for this user only.
admin-detail-use-global = Use global values
admin-detail-use-global-one = Use global value
admin-detail-delete-description = Deletes the account, { $chats ->
        [one] { $chats } chat
       *[other] { $chats } chats
    }, { $uploads ->
        [one] { $uploads } upload
       *[other] { $uploads } uploads
    }, memory and settings.
# $name is a user's name or email.
admin-detail-delete-detail = The account, { $chats ->
        [one] { $chats } chat
       *[other] { $chats } chats
    }, { $uploads ->
        [one] { $uploads } upload
       *[other] { $uploads } uploads
    }, memory and settings of { $name } are deleted.
admin-detail-id = User id: { $id }

## Sessions

admin-sessions-title = Sessions
admin-sessions-description = Devices signed in to this account.
admin-sessions-empty = No active sessions.
admin-sessions-this-device = This device
# $when is a relative time such as "3 days ago".
admin-sessions-last-active = Last active { $when }
admin-sessions-signed-in = Signed in { $date }
# $device is a device description.
admin-sessions-end-on = End session on { $device }
admin-sessions-sign-out = Sign out
admin-sessions-ended = Session ended
admin-sessions-end-failed = Could not end the session
admin-sessions-more =
    { $count ->
        [one] { $count } more session
       *[other] { $count } more sessions
    }
admin-sessions-show-all = Show all { $count }

## Limits for one user (labels of the settings in the per-user list)

admin-override-storage = Storage quota
admin-override-processes = Agent processes
admin-override-upload-size = Upload size limit
admin-override-models-allow = Allowed models
admin-override-models-deny = Denied models
admin-override-providers = Custom providers
admin-override-mcp = Custom MCP servers
admin-override-full-access = Full access
admin-override-temporary = Temporary chats
admin-override-temporary-keep = Keep temporary chats for

## Confirmations before an admin action

admin-confirm-admin-title =
    { $count ->
        [one] Make { $what } an administrator?
       *[other] Make { $count } people administrators?
    }
admin-confirm-admin-body = They can change every setting, manage all users and see usage for the whole instance.
admin-confirm-user-title =
    { $count ->
        [one] Make { $what } a regular user?
       *[other] Make { $count } people regular users?
    }
admin-confirm-user-body = They lose access to the admin pages at once. Their chats and files stay.
admin-confirm-unban-title =
    { $count ->
        [one] Unban { $what }?
       *[other] Unban { $count } people?
    }
admin-confirm-unban-body = They can sign in again at once.
admin-confirm-sign-out-title =
    { $count ->
        [one] Sign { $what } out everywhere?
       *[other] Sign { $count } people out everywhere?
    }
admin-confirm-sign-out-body = Every session ends at once. They must sign in again on each device.
admin-confirm-limits-title =
    { $count ->
        [one] Use global limits for { $what }?
       *[other] Use global limits for { $count } people?
    }
admin-confirm-limits-body = Their own limits are removed. The global limits apply instead.
admin-confirm-reload-title = Reload the config file?
admin-confirm-reload-body = The server reads the file now. Values in the file are applied, and values the file no longer holds are removed.
