#!/usr/bin/env bash
# Publish the GitHub Release for one green build of main.
#
# Tag: build-<N>, where N = `git rev-list --count <commit>`. main only moves
# forward, so every new commit has a strictly larger N than its ancestors, and
# the same commit always maps to the same tag (a re-run publishes nothing new).
#
# Env: SHA (commit built), ZIP_DIR (holds the `wxt zip` output), GH_TOKEN,
#      DRY_RUN=1 to plan and validate without publishing.
set -euo pipefail

: "${SHA:?}" "${ZIP_DIR:?}" "${GITHUB_REPOSITORY:?}"
dry_run="${DRY_RUN:-0}"

if [[ "$dry_run" != 1 && ( "${GITHUB_EVENT_NAME:-}" != push || "${GITHUB_REF:-}" != refs/heads/main ) ]]; then
  echo "::error::refusing to publish outside a push to main (event=${GITHUB_EVENT_NAME:-}, ref=${GITHUB_REF:-})"
  exit 1
fi

n=$(git rev-list --count "$SHA")
tag="build-$n"
short=${SHA:0:7}

# Already released? Same commit: a re-run, nothing to do. Different commit:
# main's history was rewritten and the numbering can no longer be trusted.
if existing=$(git rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  if [[ "$existing" == "$SHA" ]]; then
    echo "$tag already points at $short; nothing to publish."
    exit 0
  fi
  echo "::error::$tag already exists at ${existing:0:7}, not $short. Was main force-pushed?"
  exit 1
fi

# A re-run of an older build must not steal "Latest" from a newer one.
highest=$(git tag -l 'build-*' | sed 's/^build-//' | grep -E '^[0-9]+$' | sort -n | tail -n 1 || true)
latest=true
if [[ -n "$highest" && "$n" -lt "$highest" ]]; then
  latest=false
fi

shopt -s nullglob
zips=("$ZIP_DIR"/*-chrome.zip)
if [[ ${#zips[@]} -ne 1 ]]; then
  echo "::error::expected exactly one *-chrome.zip in $ZIP_DIR, found ${#zips[@]}"
  exit 1
fi
if ! unzip -Z1 "${zips[0]}" | grep -qx manifest.json; then
  echo "::error::${zips[0]} has no manifest.json at its root"
  exit 1
fi
# wxt names the zip after package.json's static version; name it after the tag.
asset="$RUNNER_TEMP/aristodromos-$tag-chrome.zip"
cp "${zips[0]}" "$asset"

notes="Built from $SHA by $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

echo "tag:    $tag"
echo "target: $SHA"
echo "latest: $latest (highest existing: ${highest:-none})"
echo "asset:  $(basename "$asset") ($(stat -c %s "$asset") bytes)"
unzip -l "$asset"

if [[ "$dry_run" == 1 ]]; then
  echo "DRY_RUN: not publishing."
  exit 0
fi

gh release create "$tag" "$asset" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$SHA" \
  --title "$tag" \
  --notes "$notes" \
  --generate-notes \
  --latest="$latest"
