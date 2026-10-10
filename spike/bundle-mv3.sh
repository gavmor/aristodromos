#!/usr/bin/env bash
# Can the RunMesh decision loop be bundled into an MV3 service worker?
#
# --platform=browser is what WXT/Vite target for an MV3 background worker: no
# Node builtins, no CJS require. The --alias flags are the SAME workaround the
# runtime needs (every @runmesh/* `exports` points at a dist/index.js that is
# not in the published tarball), so this also proves a bundler needs patching
# before it can see the package at all.
#
# Note: schema/ and memory/ are transitive-only, so under pnpm's strict layout
# they exist solely inside node_modules/.pnpm — the alias has to reach into
# store-internal paths, which is not a stable thing to ship.
set -u
cd "$(dirname "$0")/.."
V=0.1.0-alpha.1

# Real emit path for a @runmesh package: root link if hoisted, else pnpm store.
emit() {
  local pkg=$1 tail="dist/framework/packages/$1/src/index.js"
  if [ -f "node_modules/@runmesh/$pkg/$tail" ]; then
    printf './node_modules/@runmesh/%s/%s' "$pkg" "$tail"
  else
    printf './node_modules/.pnpm/@runmesh+%s@%s/node_modules/@runmesh/%s/%s' \
      "$pkg" "$V" "$pkg" "$tail"
  fi
}

ALIASES=()
for pkg in core tools agent schema memory; do
  ALIASES+=("--alias:@runmesh/$pkg=$(emit "$pkg")")
done

mkdir -p spike/.out
pnpm exec esbuild spike/mv3-entry.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --outfile=spike/.out/mv3-bundle.js \
  --metafile=spike/.out/meta.json \
  "${ALIASES[@]}"
