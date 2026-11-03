# Plugin platform host strings (docs/spec/plugins.md 14.1, 18.1, 10.1, 6.4), prefix plugin-platform-.
# Text a plugin supplies (names, titles) is data and never a message here.

## Consent to data permissions

# $name is the plugin name. $what is one of the plugin-platform-consent-* permission texts below.
plugin-platform-consent-message = Allow { $name } to { $what }? You can change this later in Settings, Apps.
plugin-platform-consent-conversations-read = read the titles and messages of your chats
plugin-platform-consent-allow = Allow
plugin-platform-consent-deny = Not now

## Data permissions in Settings, Apps

plugin-platform-grant-conversations-read = Read your chats
# $name is the plugin name.
plugin-platform-grant-description = Lets { $name } read the titles and messages of your chats. Temporary chats are never shared.

## Plugin settings

plugin-platform-settings-title = Plugin settings
plugin-platform-setting-default-for-users = Default for everyone. Each person can change it.
plugin-platform-setting-for-everyone = Applies to everyone.
plugin-platform-setting-reset = Reset to default

## Install review (Admin, Plugins)

# $name is the plugin name, $version its version.
plugin-platform-review-title = Install { $name } { $version }?
# $from and $to are versions.
plugin-platform-review-update-title = Update { $name } from { $from } to { $to }?
plugin-platform-review-permissions = It asks for:
plugin-platform-review-new = new
plugin-platform-review-turns-off = The update asks for new permissions, so Chat turns the plugin off. Turn it on again when you accept them.
plugin-platform-review-update = Update
plugin-platform-review-cancel = Cancel
# $permissions is a comma-separated list of permission names.
plugin-platform-installed-review = { $name } is updated and turned off, because it asks for new permissions: { $permissions }. Turn it on to accept them.

## Development mode

plugin-platform-dev-title = Plugin development
plugin-platform-dev-description = Load an unpacked plugin folder and reload it when its files change. For development servers only.
plugin-platform-dev-watch = Reload when the folder changes
# $time is the time of the last reload.
plugin-platform-dev-reloaded = Reloaded at { DATETIME($time, timeStyle: "medium") }
plugin-platform-dev-stop = Stop

## Plugin commands in the search dialog

# $name is the plugin name.
plugin-platform-command-needs-view = Open a { $name } file to use this command.
# $command is "<plugin>: <command title>".
plugin-platform-command-failed = { $command } did not finish

## Settings, Apps: data permissions section

plugin-platform-grants-title = What apps may read
plugin-platform-grants-description = Apps ask before they read your data. Turn one off to take it back.
