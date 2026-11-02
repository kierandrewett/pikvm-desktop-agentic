# PiKVM Desktop packages, written by pkgsmith (https://github.com/kierandrewett/pkgsmith).
#
# pkgsmith builds nothing. scripts/package.mjs builds the app and the per-platform Electron tree
# (with the web app, the agent harness UI and the agent runtime inside it), and runs
#
#     pkgsmith build --prefix builds/<tree> --build-arg PKG_OS=... --build-arg PKG_ARCH=...
#
# so the PREFIX here is one Electron tree, as electron-packager wrote it: the binary and its
# resources/ at the top for Linux and Windows, `PiKVM Desktop.app` at the top for macOS. Each
# package moves that tree to where its system keeps applications.
#
# Build arguments (all optional; scripts/package.mjs sets them):
#   PKG_OS            linux, macos or windows. Default: the system running pkgsmith.
#   PKG_ARCH          amd64 or arm64. Default: the system running pkgsmith.
#   RELEASE           package revision of this version. Default 1.
#   VERSION           default: "version" in package.json.
#   APPIMAGE_RUNTIME  path of an AppImage type 2 runtime for PKG_ARCH; the AppImage is skipped without it.

pkg = json.decode(read_file(here() + "/package.json"))
VERSION = arg("VERSION", pkg["version"])
RELEASE = arg("RELEASE", "1")
OS = arg("PKG_OS", host()["os"])
ARCH = arg("PKG_ARCH", host()["arch"])

NAME = "pikvm-desktop"
PRODUCT = "PiKVM Desktop"
APP_ID = "dev.drewett.PiKVMDesktop"
SUMMARY = "Control a PiKVM target, with an agent that can operate it"

common = {
    "name": NAME,
    "version": VERSION,
    "release": RELEASE,
    "arch": ARCH,
    "description": SUMMARY + """
One remote-control surface for one machine, driven through a PiKVM: its screen, keyboard, mouse,
power and virtual media, and a chat with an agent that can operate the same machine with your
approval. The agent runtime ships inside the app.
""",
    "maintainer": "Kieran Drewett <kieran@drewett.dev>",
    "homepage": "https://github.com/kierandrewett/pikvm-desktop-agentic",
    "license": "MIT",
}

LICENSE = here() + "/LICENSE"
ICONS = here() + "/packaging/icons"
SIZES = ["16x16", "24x24", "32x32", "48x48", "64x64", "128x128", "256x256", "512x512"]


def icons(icon_name):
    """The hicolor icon of every size, named for the desktop entry that points at it."""
    return [
        file(ICONS + "/" + size + ".png", "/usr/share/icons/hicolor/" + size + "/apps/" + icon_name + ".png", mode = "0644")
        for size in SIZES
    ]


if OS == "linux":
    LIB = "/usr/lib/" + NAME

    # The Electron tree, in one folder. chrome-sandbox must be setuid root for Chromium's sandbox on
    # systems that restrict unprivileged user namespaces; a mode on the entry sets it.
    app_tree = [
        tree("/", LIB),
        file("/chrome-sandbox", LIB + "/chrome-sandbox", mode = "4755"),
    ]

    # The same on every Linux package: a link on PATH, the launcher entry, the icons and the licence.
    desktop = [
        symlink("../lib/" + NAME + "/" + NAME, "/usr/bin/" + NAME),
        file(here() + "/packaging/pikvm-desktop.desktop", "/usr/share/applications/" + NAME + ".desktop", mode = "0644"),
        file(LICENSE, "/usr/share/licenses/" + NAME + "/LICENSE", mode = "0644"),
    ] + icons(NAME)

    # rpm and Arch pick the same icon cache refresh as deb: the desktop environment shows the new
    # entry without a re-login. Each can fail harmlessly on a system with neither tool.
    refresh = """gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true
"""
    scripts = {"post_install": refresh, "post_remove": refresh}

    # Chromium's runtime libraries; the package names differ per distro, so each format names its own.
    depends = {
        "rpm": [
            "gtk3",
            "nss",
            "libXScrnSaver",
            "libXtst",
            "libnotify",
            "at-spi2-core",
            "libuuid",
            "libsecret",
            "alsa-lib",
            "mesa-libgbm",
            "xdg-utils",
        ],
        "deb": [
            "libgtk-3-0t64 | libgtk-3-0",
            "libnss3",
            "libxss1",
            "libxtst6",
            "libnotify4",
            "libatspi2.0-0t64 | libatspi2.0-0",
            "libuuid1",
            "libsecret-1-0",
            "libasound2t64 | libasound2",
            "libgbm1",
            "xdg-utils",
        ],
        "archlinux": [
            "gtk3",
            "nss",
            "libxss",
            "libxtst",
            "libnotify",
            "at-spi2-core",
            "util-linux-libs",
            "libsecret",
            "alsa-lib",
            "mesa",
            "xdg-utils",
        ],
    }

    expose(app_tree)
    for fmt in ["rpm", "deb", "archlinux"]:
        package(fmt, depends = depends[fmt], scripts = scripts, contents = desktop, **common)

    # AppImage and Flatpak run the app from a wrapper that adds --no-sandbox where Chromium's
    # sandbox cannot start (packaging/launcher.sh), and bundle their own entry and icons.
    launcher = file(here() + "/packaging/launcher.sh", "/usr/bin/" + NAME, mode = "0755")

    APPIMAGE_RUNTIME = arg("APPIMAGE_RUNTIME", "")
    if APPIMAGE_RUNTIME:
        package(
            "appimage",
            contents = [launcher],
            options = {
                "runtime": APPIMAGE_RUNTIME,
                "icon": ICONS + "/512x512.png",
                "exec": "usr/bin/" + NAME,
                "desktop": {"name": PRODUCT, "comment": SUMMARY, "categories": "Network;RemoteAccess;"},
            },
            **common
        )

    package(
        "flatpak",
        contents = [
            launcher,
            file(here() + "/packaging/" + APP_ID + ".desktop", "/usr/share/applications/" + APP_ID + ".desktop", mode = "0644"),
            file(
                here() + "/packaging/" + APP_ID + ".metainfo.xml",
                "/usr/share/metainfo/" + APP_ID + ".metainfo.xml",
                mode = "0644",
            ),
        ] + icons(APP_ID),
        options = {
            "app_id": APP_ID,
            "runtime_version": "24.08",
            "command": NAME,
            "finish_args": [
                "--share=network",
                "--share=ipc",
                "--socket=x11",
                "--socket=wayland",
                "--socket=pulseaudio",
                "--device=dri",
            ],
        },
        **common
    )

elif OS == "macos":
    APP = PRODUCT + ".app"
    # The Applications link is the drag-to-install target of a disk image.
    expose(tree("/" + APP, "/" + APP), file(LICENSE, "/LICENSE", mode = "0644"), symlink("/Applications", "/Applications"))
    package("dmg", options = {"volume_name": PRODUCT}, **common)
    package("zip", **common)

elif OS == "windows":
    # Entry paths are taken relative to the option `prefix`, so the tree goes to one folder and the
    # option names it.
    expose(tree("/", "/" + PRODUCT), file(LICENSE, "/" + PRODUCT + "/LICENSE.pikvm-desktop.txt", mode = "0644"))
    installer = {"prefix": "/" + PRODUCT, "install_dir": PRODUCT}
    package(
        "nsis",
        options = dict(installer, install_dir = "$PROGRAMFILES64\\" + PRODUCT, shortcuts = ["/" + PRODUCT + "/" + PRODUCT + ".exe"]),
        **common
    )
    package("zip", **common)

    # The runtime's 23,900 files need about 100,000 strings, past the 65,535 an MSI holds with two-byte
    # string references; pkgsmith switches to three-byte references from 4a66ca8 on.
    package(
        "msi",
        options = dict(installer, manufacturer = "Kieran Drewett", shortcuts = ["/" + PRODUCT + "/" + PRODUCT + ".exe"]),
        **common
    )

else:
    fail("PKG_OS must be linux, macos or windows, not " + OS)
