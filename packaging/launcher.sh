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
    # The Flatpak asks for fallback-x11, so the X11 socket is absent whenever Wayland works. Electron
    # picks its platform from XDG_SESSION_TYPE, which a Flatpak may not carry, and would then try X11
    # and exit. Name Wayland outright when the session has it; with no Wayland, the default is X11.
    if [ -n "${WAYLAND_DISPLAY:-}" ]; then
        set -- --ozone-platform=wayland "$@"
    fi
    set -- --no-sandbox "$@"
elif [ -n "${APPIMAGE:-}" ] && ! unshare --user true 2>/dev/null; then
    set -- --no-sandbox "$@"
fi

exec "$app" "$@"
