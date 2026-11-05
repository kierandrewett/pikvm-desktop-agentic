#!/usr/bin/env bash
# Attach one build's packages to the release of this run, as soon as the build has them.
#
#   scripts/ci-publish.sh <dir with the packages>
#
# Builds finish at different times, so the first one to get here creates the release and every later one adds to
# it: first in, first out, with nobody waiting for the slowest runner. Needs RELEASE_TAG and GH_TOKEN, and
# GITHUB_REPOSITORY (set by Actions).
#
# No lock or queue is needed. A tag has one release, so creating it is atomic on GitHub's side: of two builds that
# try at once, one wins and the other gets an error and goes on to upload. Uploads of different file names do not
# touch each other. (An Actions concurrency group would be wrong here: it keeps one waiting job and cancels the rest.)
#
# RELEASE_TEST=true is a test run: the tag is a throwaway (made here, if it is missing) and the release is a
# pre-release, so it goes through the same atomic path as a real one. Delete both afterwards.
#
# A file name must be unique across builds (the names carry the architecture); a repeat would replace the earlier
# upload, because a re-run of one build has to be able to replace its own files.
set -euo pipefail

dir="${1:?directory with the packages}"
tag="${RELEASE_TAG:?RELEASE_TAG}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}"

shopt -s nullglob
files=("$dir"/*)
if [ "${#files[@]}" -eq 0 ]; then
    echo "[publish] no files in $dir" >&2
    exit 1
fi

# `gh release list` shows every release; the tag is what names it.
exists() {
    gh release list --repo "$repo" --limit 100 --json tagName -q '.[].tagName' | grep -qxF "$tag"
}

if ! exists; then
    create=(--repo "$repo" --title "$tag" --generate-notes --verify-tag)
    if [ "${RELEASE_TEST:-}" = "true" ]; then
        # Creating a ref that exists is refused, so concurrent builds agree on one tag.
        gh api -X POST "repos/$repo/git/refs" -f "ref=refs/tags/$tag" -f "sha=${GITHUB_SHA:?GITHUB_SHA}" >/dev/null 2>&1 \
            || echo "[publish] tag $tag exists or lost the race"
        create+=(--prerelease)
    fi
    # Another build may create it in the same second; the loser's error is fine, the check below decides.
    echo "[publish] creating release $tag"
    gh release create "$tag" "${create[@]}" || echo "[publish] create failed or lost the race; checking"
    for _ in $(seq 10); do
        exists && break
        sleep 3
    done
    exists || { echo "[publish] release $tag does not exist and could not be created" >&2; exit 1; }
fi

for attempt in 1 2 3; do
    if gh release upload "$tag" "${files[@]}" --repo "$repo" --clobber; then
        echo "[publish] attached ${#files[@]} files to $tag"
        exit 0
    fi
    echo "[publish] upload failed (attempt $attempt of 3)" >&2
    sleep 10
done
exit 1
