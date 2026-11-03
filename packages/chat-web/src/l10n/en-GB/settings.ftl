# Settings. So far only the language choice (l10n/provider.tsx useLocaleOptions, the account menu and the
# Language row). Row labels and descriptions still come from components/settings/registry.ts.

settings-language = Language
# First option of the language picker. $language is the browser's language in its own name ("Français").
settings-language-browser = Browser default ({ $language })

# Settings shell: navigation column, search field, load and access errors.
settings-title = Settings
settings-close = Close settings
settings-search-label = Search settings
settings-search-placeholder = Search
settings-search-no-match = No matching settings
settings-group-admin = Administration
settings-admin-badge = Admin
settings-go-to-settings = Go to settings
settings-load-failed = Could not load settings
settings-not-found-title = Not found
settings-not-found-text = This settings page does not exist.
settings-admin-only = Only administrators can open this page.

# Settings search results page. $page is the name of a settings page.
settings-search-open-page = Open { $page }
settings-search-hidden-matches = The matching settings show when the options they depend on are turned on.
settings-search-status-idle = Type in the search field to find a setting.
settings-search-status-none = No results.
settings-search-status-pages =
    { $pages ->
        [one] { $pages } page matches.
       *[other] { $pages } pages match.
    }
# Two plurals in one sentence: "3 settings on 2 pages". The selector picks the word for each count.
settings-search-status-settings =
    { $settings ->
        [one] { $settings } setting on { $pages ->
            [one] { $pages } page
           *[other] { $pages } pages
        }
       *[other] { $settings } settings on { $pages ->
            [one] { $pages } page
           *[other] { $pages } pages
        }
    }
# $query is what the person typed.
settings-search-empty-title = No settings match “{ $query }”
settings-search-empty-description = Search looks at setting names, descriptions and related words. Check the spelling, or try one of these:
settings-search-results-label = Settings search results
settings-search-results-title = Search results

# Settings kit: shared controls, rows and sections used by every settings page.
settings-cancel = Cancel
settings-save = Save
settings-remove = Remove
settings-add = Add
settings-optional = (optional)
settings-reset-default = Reset to default
settings-select-placeholder = Select
settings-enum-none = None
settings-edit-in-advanced = Edit in Advanced
settings-advanced = Advanced
# $first is a comma separated list of up to three row names. $count is how many more rows the section holds.
settings-advanced-more =
    { $count ->
        [one] { $first } and { $count } more
       *[other] { $first } and { $count } more
    }
settings-danger-zone = Danger zone
settings-page-actions = Page actions
settings-more-actions = More actions
# $page is the name of the settings page the person came from.
settings-back-to = Back to { $page }
settings-back-to-settings = Back to settings
settings-lock-file = Managed by the config file
settings-lock-admin = Set by your administrator
settings-lock-policy = Turned off by your administrator
settings-error-managed-by-file = This value is managed by the config file.
settings-status-saving = Saving
settings-status-saved = Saved
# $label is the setting name. $unit is MB or GB.
settings-bytes-in-unit = { $label } in { $unit }
settings-bytes-unit = { $label } unit
# $message is the error text from the browser's JSON parser.
settings-json-invalid = Not valid JSON: { $message }
settings-json-invalid-value = Invalid value
settings-json-label = { $label } as JSON
settings-json-discard-title = Discard unsaved settings?
settings-json-discard-description = This JSON draft has not been saved. Stay on this page to save it, or discard it to leave.
settings-json-discard-confirm = Discard draft
settings-number-enter-between = Enter { NUMBER($min, useGrouping: "false") } to { NUMBER($max, useGrouping: "false") }
settings-number-enter-min = Enter at least { NUMBER($min, useGrouping: "false") }
settings-number-decrease = Decrease { $label }
settings-number-increase = Increase { $label }
settings-color-picker = { $label } picker
settings-list-add-to = Add to { $label }
settings-list-remove = Remove { $item }
settings-pairs-name = { $label } { $index } name
settings-pairs-value = { $label } { $index } value
settings-pairs-name-placeholder = Name
settings-pairs-value-placeholder = Value
settings-pairs-remove-row = Remove row
# $label is the setting name in lower case.
settings-secret-new = New { $label }
settings-secret-remove-confirm = Remove the stored { $label }? It cannot be shown again.
settings-secret-not-set = Not set
settings-secret-replace = Replace

# Settings pages: General, Memory, Notifications.
settings-memory-section = Memory
settings-memory-open = Open Memory
settings-notifications-title = Notifications
settings-notifications-where = Where
settings-notifications-events = Events
settings-notifications-browser = Browser notifications
settings-notifications-unsupported = This browser does not support notifications.
settings-notifications-denied = Notifications are blocked for this site. Allow them in your browser's site settings.
settings-notifications-pending = Your browser has not given permission yet.

# Keyboard shortcuts page. Key names come from lib/media.
settings-shortcuts-new-chat = New chat
settings-shortcuts-search-chats = Search chats
settings-shortcuts-search-everything = Search everything
settings-shortcuts-open-settings = Open settings
settings-shortcuts-show-or-hide-the-sidebar = Show or hide the sidebar
settings-shortcuts-show-or-hide-the-side-panel = Show or hide the side panel
settings-shortcuts-temporary-chat = Temporary chat
settings-shortcuts-previous-message-of-yours = Previous message of yours
settings-shortcuts-next-message-of-yours = Next message of yours
settings-shortcuts-undo-a-rewind-fork-or-other-chat-change = Undo a rewind, fork or other chat change
settings-shortcuts-open-the-model-picker = Open the model picker
settings-shortcuts-pick-a-favourite-model = Pick a favourite model
settings-shortcuts-add-or-remove-a-favourite = Add or remove a favourite
settings-shortcuts-zoom-in = Zoom in
settings-shortcuts-zoom-out = Zoom out
settings-shortcuts-find-in-a-document = Find in a document
settings-shortcuts-send-message = Send message
settings-shortcuts-new-line = New line
settings-shortcuts-group-general = General
settings-shortcuts-group-chat = Chat
settings-shortcuts-group-model-picker = Model picker
settings-shortcuts-group-files = Files
settings-shortcuts-group-composer = Composer
settings-shortcuts-composer-note = Change the send key in Chat settings.
settings-shortcuts-title = Keyboard shortcuts

# Personalization and Tools pages.
settings-personalization-title = Personalization
settings-personalization-instructions-label = Custom instructions
settings-personalization-instructions-placeholder = For example: Answer briefly. Use British English.
settings-tools-engine-auto = Automatic
# $servers is the number of servers that are on. $changed is the number of tools with their own policy.
settings-tools-name-placeholder = Tool name

# Chat page.
settings-chat-title = Chat
settings-chat-models = Models
settings-chat-default-model = Default model
settings-chat-effort-off = Off
settings-chat-effort-minimal = Minimal
settings-chat-effort-low = Low
settings-chat-effort-medium = Medium
settings-chat-effort-high = High
settings-chat-effort-xhigh = Extra high
settings-chat-effort-max = Max
settings-chat-messages = Messages
settings-chat-permission-ask = Ask before acting
settings-chat-permission-full = Full access
settings-chat-permission-blocked = Full access is turned off by your administrator.
# Follows the key names under the send shortcut row: "Enter sends . Shift+Enter adds a new line".
settings-chat-sends = sends
settings-chat-adds-new-line = adds a new line
settings-chat-reactions = Reactions
settings-chat-reaction-label = Double-click reaction
settings-chat-reaction-off = Off
settings-chat-reaction-recent = Most recent
settings-chat-group-vendor = Vendor
settings-chat-group-provider = Provider

# Archived chats and data controls.
settings-delete = Delete
settings-archived-title = Archived chats
settings-archived-untitled = New chat
# $date is a short date in the person's language.
settings-archived-on = Archived { $date }
# $title is the chat title.
settings-archived-delete-named = Delete { $title }
settings-archived-delete-chat = Delete chat
settings-archived-unarchive = Unarchive
settings-archived-loading = Loading archived chats...
settings-archived-load-failed = Could not load archived chats
settings-archived-empty = No archived chats
settings-archived-empty-description = Archive a chat from its menu to keep it out of the sidebar.
settings-archived-delete-title = Delete chat?
settings-archived-delete-description = "{ $title }" and its files are deleted. You can undo this for a few seconds.
settings-data-deleting = Deleting { $done } of { $total }...
# $deleted chats were deleted. $failed is how many could not be deleted (zero shows nothing).
settings-data-deleted =
    { $deleted ->
        [one] Deleted { $deleted } chat
       *[other] Deleted { $deleted } chats
    }{ $failed ->
        [0] { "" }
       *[other] , { $failed } failed
    }.
settings-data-delete-all = Delete all
settings-data-confirm-title = Delete all chats?
settings-data-confirm-description = Every chat and its files are deleted. This cannot be undone.

# Speech pages. $provider is the id of a provider that no longer exists.
settings-speech-title = Speech and voice
settings-speech-services-title = Speech services
settings-speech-dictation = Dictation
settings-speech-read-aloud = Read aloud
settings-speech-mode-off = Off
settings-speech-mode-browser = Browser
settings-speech-mode-server = Server
settings-speech-own-endpoint = Own endpoint
settings-speech-provider-missing = { $provider } (missing)
settings-speech-provider = Provider
settings-speech-automatic = Automatic

# Appearance page. Theme preset names and font names are data and are not translated.
settings-appearance-title = Appearance
settings-appearance-reset = Reset appearance
settings-appearance-reset-title = Reset appearance?
settings-appearance-reset-description = Mode, theme, colours, fonts and layout go back to their defaults.
settings-appearance-reset-confirm = Reset
settings-appearance-reset-failed = Could not reset appearance
settings-appearance-section-theme = Theme
settings-appearance-section-layout = Layout and type
settings-appearance-section-effects = Effects
settings-appearance-section-motion = Motion
settings-appearance-mode = Mode
settings-appearance-mode-system = System
settings-appearance-mode-light = Light
settings-appearance-mode-dark = Dark
settings-appearance-theme = Theme
settings-appearance-import-theme = Import theme from clipboard
settings-appearance-copy-theme = Copy theme
settings-appearance-theme-copied = Theme copied to the clipboard
settings-appearance-theme-imported = Theme imported
settings-appearance-clipboard-write-failed = Could not write to the clipboard
settings-appearance-theme-import-failed = The clipboard does not hold a copied theme
settings-appearance-accent = Accent
settings-appearance-accent-preset = Accent preset
settings-appearance-accent-default = Default
settings-appearance-custom = Custom
settings-appearance-ambient-memories = Memories
settings-appearance-ambient-theme = Theme
settings-appearance-ambient-off = Off
settings-appearance-font = Font
settings-appearance-code-font = Code font
settings-appearance-font-custom = Custom...
# $label is the font setting name.
settings-appearance-font-family = { $label } family
settings-appearance-font-placeholder = Installed font name
settings-appearance-density-compact = Compact
settings-appearance-density-default = Default
settings-appearance-density-comfortable = Comfortable
settings-appearance-roundness = Roundness
settings-appearance-round-square = Square
settings-appearance-round-subtle = Subtle
settings-appearance-round-default = Default
settings-appearance-round-round = Round
settings-appearance-dock-fade = Fade
settings-appearance-dock-solid = Solid
settings-appearance-motion-system = System
settings-appearance-motion-on = On
settings-appearance-motion-off = Off
settings-appearance-speed = Animation speed
settings-appearance-speed-off = Off
settings-appearance-speed-fast = Fast
settings-appearance-speed-normal = Normal
settings-appearance-speed-relaxed = Relaxed
settings-appearance-speed-slow = Slow
settings-appearance-easing = Easing
# Sample content in the layout preview.
settings-appearance-preview-chat-1 = Trip plan
settings-appearance-preview-chat-2 = Release notes
settings-appearance-preview-chat-3 = Recipe ideas
settings-appearance-preview-message = Plan a weekend in Bath
settings-appearance-preview-composer = Ask anything
settings-appearance-search-global = Search everything
settings-appearance-search-filter = Filter sidebar
settings-appearance-sidebar-sections = Sidebar section views
settings-appearance-agent-id = agent id
settings-appearance-files-grid = Grid
settings-appearance-files-list = List
settings-appearance-files-tree = Tree

# Plugins (Admin) and Apps pages. Plugin names, publishers and descriptions are data and are not translated.
settings-plugins-permission-storage = Save its own data for each user
settings-plugins-permission-conversations = Read each user's chats (titles and messages)
settings-plugins-permission-downloads = Offer files to download (each user confirms every file)
# $host is a network host name.
settings-plugins-permission-network = Connect to { $host }
settings-plugins-count-apps =
    { $count ->
        [one] { $count } app
       *[other] { $count } apps
    }
settings-plugins-count-editors =
    { $count ->
        [one] { $count } editor
       *[other] { $count } editors
    }
settings-plugins-count-tools =
    { $count ->
        [one] { $count } assistant tool
       *[other] { $count } assistant tools
    }
settings-plugins-count-commands =
    { $count ->
        [one] { $count } command
       *[other] { $count } commands
    }
settings-plugins-not-valid = Not valid
settings-plugins-enabled = Enabled
settings-plugins-uninstall = Uninstall
# $name is the plugin name.
settings-plugins-enable = Enable { $name }
settings-plugins-permissions = Permissions
settings-plugins-no-permissions = No extra permissions
settings-plugins-editor-note = Opens and saves the documents it is used for
settings-plugins-system-off = Turn on the plugin system above to make it available.
settings-plugins-uninstall-title = Uninstall { $name }?
settings-plugins-uninstall-description = The package is removed for everyone. Documents it created stay in each user's files.
settings-plugins-purge = Also delete data this plugin saved for every user
settings-plugins-install = Install
settings-plugins-install-description = A .zip with plugin.json at its root. New plugins start off.
settings-plugins-upload = Upload a package
settings-plugins-upload-description = A .zip of up to 20 MB.
settings-plugins-package = Plugin package
settings-plugins-upload-button = Upload .zip
settings-plugins-folder = Install from a folder on the server
settings-plugins-folder-description = An absolute path, for example /opt/chat-plugins/notes.
settings-plugins-folder-path = Folder path
settings-plugins-install-button = Install
settings-plugins-installed = Installed { $name }. Turn it on below.
settings-plugins-system = Plugin system
settings-plugins-system-description = Apps, editors and tools from plugins, for every user.
settings-plugins-list = Installed
settings-plugins-loading = Loading plugins
# $message is the error text.
settings-plugins-load-failed = Could not load plugins. { $message }
settings-plugins-none = No plugins installed.
settings-plugins-managed = config.toml sets which plugins are enabled, so they cannot change here.
settings-plugins-api = Plugin API { $version }
settings-plugins-assistant = Assistant
# $name is the app title.
settings-apps-show = Show { $name } in the rail
settings-apps-none = No apps are installed.
settings-apps-rail = Rail
settings-apps-rail-description = Hide the apps you do not use.

# Account page, Profile section. $size is a formatted file size, $email is the person's email address.
settings-profile-heading = Profile
settings-profile-name = Name
settings-profile-name-required = Enter a name.
settings-profile-rename-failed = Could not change your name
settings-profile-role-admin = Administrator
settings-profile-role-member = Member
# $date is a month and year in the person's language.
settings-profile-member-since = Member since { $date }
settings-profile-upload-photo = Upload photo
settings-profile-replace-photo = Replace photo
settings-profile-choose-photo = Choose a photo
settings-profile-remove-title = Remove your photo?
settings-profile-remove-description = The photo is deleted from this server and your initials show instead.
settings-profile-remove-failed = Could not remove the picture
settings-profile-picture-updated = Profile picture updated
settings-profile-picture-removed = Profile picture removed
settings-profile-photo-svg = SVG images are not supported. Use a PNG, JPEG, WebP or GIF image.
settings-profile-photo-not-image = This file is not an image. Use a PNG, JPEG, WebP or GIF image.
settings-profile-photo-too-large = This file is larger than { $size }.
settings-profile-photo-unreadable = This image could not be read. The file may be damaged.
settings-profile-photo-still-large = The cropped photo is still too large. Try a smaller image.
settings-profile-crop-title = Crop your photo
settings-profile-crop-area = Crop area. Drag the photo or use the arrow keys to move it, and plus or minus to zoom.
settings-profile-crop-unsupported = This browser cannot crop images.
settings-profile-crop-failed = The photo could not be prepared. Try another image.
settings-profile-zoom = Zoom
settings-profile-saving = Saving...
settings-profile-save-photo = Save photo
settings-profile-picture = Profile picture
settings-profile-source-initials = Initials
settings-profile-source-photo = Photo
settings-profile-source-provider = Sign-in provider
settings-profile-gravatar-checking = Looking for your Gravatar...
settings-profile-gravatar-disabled = Your administrator turned off Gravatar. Showing your initials.
settings-profile-gravatar-missing = There is no Gravatar for { $email }, so your initials show. <create>Create one on Gravatar</create>
settings-profile-gravatar-unavailable = Could not reach Gravatar. Showing your initials for now.
settings-profile-gravatar-found = Showing the Gravatar for { $email }.
settings-profile-no-photo = No photo uploaded yet. Showing your initials.
settings-profile-gravatar-privacy = This server fetches Gravatar pictures itself, so Gravatar never sees your browser.
# $message is the error text.
settings-profile-load-failed = Could not load your picture settings: { $message }

# Account page: sign-in, two-factor, passkeys, connected accounts, sessions.
settings-account-title = Account
settings-account-sign-in = Sign in
settings-account-request-failed = Request failed
settings-account-just-now = just now
settings-account-done = Done
settings-account-change = Change
settings-account-no-password = This account has no password. It signs in another way.
settings-account-password-title = Change password
settings-account-password-current = Current password
settings-account-password-new = New password
settings-account-password-confirm = Confirm new password
settings-account-password-revoke = Sign out of other sessions
settings-account-password-changed = Your password has been changed.
settings-account-password-short =
    { $count ->
        [one] Use at least { $count } character.
       *[other] Use at least { $count } characters.
    }
settings-account-password-min =
    { $count ->
        [one] At least { $count } character.
       *[other] At least { $count } characters.
    }
settings-account-password-mismatch = The new passwords do not match.
settings-account-backup-codes = Backup codes
settings-account-copied = Copied
settings-account-copy-codes = Copy codes
settings-account-2fa-on = On
settings-account-2fa-needs-password = Set a password first to use two-factor authentication.
settings-account-2fa-backup-codes = Backup codes
settings-account-2fa-turn-off = Turn off
settings-account-2fa-turn-on = Turn on
settings-account-2fa-enable-title = Turn on two-factor authentication
settings-account-2fa-disable-title = Turn off two-factor authentication
settings-account-2fa-codes-title = New backup codes
settings-account-2fa-off-toast = Two-factor authentication is off
settings-account-2fa-email-unsupported = This server sends codes by email, which is not supported here.
settings-account-2fa-password = Password
settings-account-2fa-password-help = Confirm it is you.
settings-account-2fa-setup = Add this account to your authenticator app with the setup key or link, then enter the 6-digit code it shows.
settings-account-2fa-setup-key = Setup key
settings-account-2fa-setup-link = Setup link
settings-account-2fa-code = Code
settings-account-2fa-codes-enabled = Two-factor authentication is on. Keep these backup codes somewhere safe. Each code works once if you lose your authenticator.
settings-account-2fa-codes-keep = Keep these backup codes somewhere safe. Each code works once if you lose your authenticator.
settings-account-2fa-verify = Verify
settings-account-2fa-continue = Continue
settings-account-passkey = Passkey
settings-account-passkey-add = Add passkey
settings-account-passkey-add-failed = Could not add the passkey
settings-account-passkey-added = Passkey added
settings-account-passkey-deleted = Passkey deleted
settings-account-passkey-update-failed = Could not update passkeys
settings-account-passkey-waiting = Waiting for device...
settings-account-passkey-loading = Loading passkeys...
settings-account-passkey-load-failed = Could not load passkeys
settings-account-passkey-none = No passkeys yet. Your password keeps working when you add one.
# $date is a medium date in the person's language.
settings-account-passkey-added-on = Added { $date }
settings-account-passkey-added-synced = Added { $date } · Synced
# $name is the passkey name the person chose.
settings-account-passkey-name-of = Name of { $name }
settings-account-passkey-name-default = Name of passkey
settings-account-passkey-delete-named = Delete { $name }
settings-account-passkey-delete-default = Delete passkey
settings-account-passkey-delete-title = Delete passkey?
settings-account-passkey-delete-description = You can no longer sign in with "{ $name }".
settings-account-passkey-this = this passkey
settings-account-provider-credential = Email and password
settings-account-disconnected = Account disconnected
settings-account-accounts-update-failed = Could not change connected accounts
settings-account-accounts-loading = Loading connected accounts...
settings-account-accounts-load-failed = Could not load connected accounts
settings-account-connected-on = Connected { $date }
settings-account-not-connected = Not connected
settings-account-connect = Connect
settings-account-disconnect = Disconnect
# $provider is the sign-in provider name.
settings-account-disconnect-title = Disconnect { $provider }?
settings-account-disconnect-description = You can no longer sign in with it. You can connect it again later.
settings-account-sessions = Sessions
settings-account-sessions-loading = Loading sessions...
settings-account-sessions-load-failed = Could not load sessions
settings-account-this-device = This device
settings-account-active-now = Active now
# $when is a relative time such as "5 minutes ago".
settings-account-last-active = Last active { $when }
settings-account-signed-in-on = Signed in { $date }
# $device is the browser and system name of the session.
settings-account-session-signed-out = Signed out { $device }
settings-account-session-sign-out-failed = Could not sign out the session
settings-account-session-sign-out-label = Sign out { $device }, last active { $when }
settings-account-sign-out = Sign out
settings-account-no-other-devices = No other devices are signed in to your account.
settings-account-more-sessions =
    { $count ->
        [one] { $count } more session
       *[other] { $count } more sessions
    }
settings-account-show-all = Show all { $count }
settings-account-others-signed-out = Other sessions signed out
settings-account-sign-out-failed = Could not sign out
settings-account-none-signed-in = No other devices are signed in.
settings-account-sign-out-count =
    { $count ->
        [one] Sign out { $count } session
       *[other] Sign out { $count } sessions
    }
settings-account-sign-out-others = Sign out other sessions
settings-account-sign-out-everywhere = Sign out everywhere
settings-account-others-title = Sign out other sessions?
settings-account-others-description = Every other device signed in to your account is signed out. This device stays signed in.
settings-account-everywhere-title = Sign out everywhere?
settings-account-everywhere-description = Every device is signed out, including this one. You need to sign in again.

# In-page navigation on long settings pages: the accessible name of the list of section buttons.
settings-sections-nav = Sections on this page
