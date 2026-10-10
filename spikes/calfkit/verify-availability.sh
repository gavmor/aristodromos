#!/usr/bin/env bash
# Reproduces the evidence behind SPIKE-FINDINGS.md for spike(bg-harness): calfkit-sdk.
#
# The spike's verdict (INFEASIBLE) rests on two checkable facts:
#   1. calfkit has no JavaScript/TypeScript distribution.
#   2. a Kafka-compatible broker is a mandatory dependency, not an opt-in extra.
#
# Needs: curl, jq, npm. Read-only — installs nothing.

set -uo pipefail

echo "=== 1. npm registry: candidate package names ==="
for pkg in calfkit-sdk calfkit calf-ai @calf-ai/sdk @calfkit/sdk calf-sdk calfkit-ai; do
  if version=$(npm view "$pkg" version 2>/dev/null); then
    printf '  %-16s FOUND %s\n' "$pkg" "$version"
  else
    printf '  %-16s not found (404)\n' "$pkg"
  fi
done

echo
echo "=== 2. npm search 'calfkit' ==="
npm search calfkit --json 2>/dev/null | jq -r 'if length == 0 then "  (no results)" else .[].name end'

echo
echo "=== 3. PyPI: the actual distribution ==="
curl -sS https://pypi.org/pypi/calfkit/json |
  jq -r '.info | "  version:         \(.version)\n  summary:         \(.summary)\n  requires_python: \(.requires_python)"'

echo
echo "=== 4. Mandatory (non-extra) dependencies of the published release ==="
echo "    note the Kafka client sitting in the BASE dependency set:"
curl -sS https://pypi.org/pypi/calfkit/json |
  jq -r '.info.requires_dist[]? | select(test("extra ==") | not) | "  \(.)"'

echo
echo "=== 5. The '[mesh]' extra — the 'zero-setup' local dev path ==="
curl -sS https://pypi.org/pypi/calfkit/json |
  jq -r '.info.requires_dist[]? | select(test("extra == \"mesh\"")) | "  \(.)"'
echo "  calfkit-mesh describes itself as:"
curl -sS https://pypi.org/pypi/calfkit-mesh/json | jq -r '"    \"" + .info.summary + "\""'

echo
echo "=== 6. Repository layout: Python project, no package.json ==="
curl -sS https://api.github.com/repos/calf-ai/calfkit-sdk/contents/ |
  jq -r '.[] | "  \(.type)  \(.name)"'

echo
echo "=== 7. Where the repo's JavaScript bytes actually live ==="
echo "    GitHub's language bar shows JavaScript, but it is agent-skill tooling,"
echo "    not an SDK surface:"
curl -sS "https://api.github.com/repos/calf-ai/calfkit-sdk/git/trees/main?recursive=1" |
  jq -r '.tree[] | select(.path | test("\\.(js|cjs|mjs|ts)$")) | "  \(.path)"'
