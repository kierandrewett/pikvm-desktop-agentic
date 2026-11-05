#!/usr/bin/env bash
# Build the signed Flatpak repository that `flatpak update` reads, from the .flatpak bundles of a release.
#
#   scripts/flatpak-repo.sh <bundles-dir> <site-dir> <base-url>
#
# <site-dir> gets repo/ (the OSTree repository), pikvm-desktop.flatpakrepo (add once with
# `flatpak remote-add`) and dev.drewett.PiKVMDesktop.flatpakref (one-click install). The commits in the
# repository are signed with the key in FLATPAK_GPG_HOME / FLATPAK_GPG_KEY_ID; the matching public key is
# packaging/flatpak-repo.gpg.b64 and is embedded in both files, so clients verify what they download.
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

bundles="${1:?bundles dir}"
site="${2:?site dir}"
base="${3:?base url, for example https://user.github.io/repo}"
here="$(cd "$(dirname "$0")/.." && pwd)"
key="${FLATPAK_GPG_KEY_ID:?FLATPAK_GPG_KEY_ID}"
gpghome="${FLATPAK_GPG_HOME:?FLATPAK_GPG_HOME}"
app="dev.drewett.PiKVMDesktop"
pub="$(tr -d '\n' <"$here/packaging/flatpak-repo.gpg.b64")"

rm -rf "$site"
mkdir -p "$site"
ostree init --repo="$site/repo" --mode=archive-z2

shopt -s nullglob
bundle_files=("$bundles"/*.flatpak)
if [ "${#bundle_files[@]}" -eq 0 ]; then
    echo "[flatpak-repo] no .flatpak files in $bundles" >&2
    exit 1
fi

# The bundles come from pkgsmith, which writes no appstream catalogue (flatpak build-finish normally does):
# without files/share/app-info the repository's catalogue is empty, and a software centre shows the app with no
# name, summary or version. Each bundle is therefore checked out, given a metainfo that names this release,
# composed into files/share/app-info, and committed to the repository from that tree.
version="${RELEASE_VERSION:?RELEASE_VERSION, for example 1.14.1}"
released="${RELEASE_DATE:-$(date -u +%F)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
refs_file="$work/refs"
: >"$refs_file"
for bundle in "${bundle_files[@]}"; do
    name="$(basename "$bundle")"
    echo "[flatpak-repo] importing $name"
    staging="$work/in-$name"
    ostree init --repo="$staging" --mode=archive-z2
    flatpak build-import-bundle "$staging" "$bundle"
    ref="$(ostree --repo="$staging" refs | grep -m1 "^app/$app/")"
    arch="$(cut -d/ -f3 <<<"$ref")"
    branch="$(cut -d/ -f4 <<<"$ref")"
    tree="$work/tree-$name"
    ostree --repo="$staging" checkout --user-mode "$ref" "$tree"
    meta="$tree/files/share/metainfo/$app.metainfo.xml"
    [ -f "$meta" ] || { echo "[flatpak-repo] $name has no $meta" >&2; exit 1; }
    mkdir -p "$tree/export/share/metainfo"
    sed "s#</component>#  <releases>\n    <release version=\"$version\" date=\"$released\"/>\n  </releases>\n</component>#" \
        "$meta" >"$work/metainfo.xml"
    grep -q "<release version=\"$version\"" "$work/metainfo.xml"
    cp -f "$work/metainfo.xml" "$meta"
    cp -f "$work/metainfo.xml" "$tree/export/share/metainfo/$app.metainfo.xml"
    mkdir -p "$tree/files/share/app-info/xmls" "$tree/files/share/app-info/icons/flatpak"
    appstreamcli compose --no-net --origin=flatpak --prefix=/files --components="$app" \
        --data-dir="$tree/files/share/app-info/xmls" --icons-dir="$tree/files/share/app-info/icons/flatpak" \
        --result-root="$work/compose-$name" "$tree"
    # compose names the file after the origin; Flatpak looks for the app id.
    mv "$tree/files/share/app-info/xmls/flatpak.xml.gz" "$tree/files/share/app-info/xmls/$app.xml.gz"
    flatpak build-export --gpg-homedir="$gpghome" --gpg-sign="$key" --arch="$arch" "$site/repo" "$tree" "$branch"
    printf '%s %s\n' "$ref" "$name" >>"$refs_file"
    rm -rf "$staging" "$tree"
done

flatpak build-update-repo --gpg-homedir="$gpghome" --gpg-sign="$key" --prune --title="PiKVM Desktop" "$site/repo"

# A bundle installed from a file has no remote, so `flatpak update` has nothing to ask. Rebuilt with the
# repository's address and key inside, installing the file adds that remote and the app updates from it.
# The names stay the same, so the release's files can be replaced one for one.
# Each bundle is a single-threaded compression of a few hundred MB and they read the repository without writing to
# it, so the architectures run side by side; the wait fails the script if either one failed.
mkdir -p "$site-bundles"
printf '%s' "$pub" | base64 -d >"$work/repo.gpg"
pids=()
while read -r ref name; do
    arch="$(cut -d/ -f3 <<<"$ref")"
    branch="$(cut -d/ -f4 <<<"$ref")"
    (
        flatpak build-bundle --arch="$arch" --repo-url="$base/repo/" --gpg-keys="$work/repo.gpg" \
            --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
            "$site/repo" "$site-bundles/$name" "$app" "$branch"
        echo "[flatpak-repo] bundle with origin: $name"
    ) &
    pids+=("$!")
done <"$refs_file"
# Every worker is waited for, so a failed one cannot leave another still writing when the script exits; then the failure is reported.
failed=0
for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "[flatpak-repo] a bundle failed" >&2; exit 1; }

cat >"$site/pikvm-desktop.flatpakrepo" <<EOF
[Flatpak Repo]
Title=PiKVM Desktop
Url=$base/repo/
Homepage=$base/
Comment=PiKVM Desktop builds
GPGKey=$pub
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
EOF

cat >"$site/$app.flatpakref" <<EOF
[Flatpak Ref]
Title=PiKVM Desktop
Name=$app
Branch=stable
Url=$base/repo/
SuggestRemoteName=pikvm-desktop
IsRuntime=false
GPGKey=$pub
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
EOF

# Pages serves the site root; a landing page keeps the URL from being a 404.
cat >"$site/index.html" <<EOF
<!doctype html>
<meta charset="utf-8">
<title>PiKVM Desktop Flatpak repository</title>
<h1>PiKVM Desktop Flatpak repository</h1>
<p>Add it once: <code>flatpak remote-add --user pikvm-desktop $base/pikvm-desktop.flatpakrepo</code></p>
<p>Install: <code>flatpak install --user pikvm-desktop $app</code>. After that, <code>flatpak update</code> brings new releases.</p>
<p>Or open <a href="$app.flatpakref">$app.flatpakref</a> in your software centre.</p>
EOF
echo "[flatpak-repo] done: $site"
