#!/bin/sh
# Starts PiKVM Desktop from an AppImage or a Flatpak, where the app tree sits beside this script
# (usr/bin/pikvm-desktop next to usr/lib/pikvm-desktop). The rpm, deb and Arch packages link the
# binary directly and do not use this.
#
# Chromium's sandbox needs either a setuid chrome-sandbox or unprivileged user namespaces. Neither
# is available here: an AppImage is mounted nosuid, and Flatpak already sandboxes the app and
# forbids nesting. So the flag is added only where the sandbox cannot start, rather than always.
set -eu
here=$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
app="$here/../lib/pikvm-desktop/pikvm-desktop"

if [ -n "${FLATPAK_ID:-}" ]; then
    set -- --no-sandbox "$@"
elif [ -n "${APPIMAGE:-}" ] && ! unshare --user true 2>/dev/null; then
    set -- --no-sandbox "$@"
fi

exec "$app" "$@"
