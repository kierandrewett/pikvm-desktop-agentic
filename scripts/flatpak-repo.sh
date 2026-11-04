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
for bundle in "${bundle_files[@]}"; do
    echo "[flatpak-repo] importing $(basename "$bundle")"
    flatpak build-import-bundle --gpg-homedir="$gpghome" --gpg-sign="$key" "$site/repo" "$bundle"
done

flatpak build-update-repo --gpg-homedir="$gpghome" --gpg-sign="$key" --prune --title="PiKVM Desktop" "$site/repo"

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
