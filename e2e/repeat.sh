#!/usr/bin/env bash
# Repeat the headless end-to-end run N times and tally convergence.
#
#   ./e2e/repeat.sh 8
#
# One green run proves the loop CAN close. The thing worth knowing is how often
# it does, because the weak link is the local model, not the wiring — the spike
# that chose this harness measured 4/6 on the same box and said so.
set -uo pipefail

RUNS="${1:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/evidence/runs"
mkdir -p "$LOGS"

pass=0
fail=0
i=1
while [ "$i" -le "$RUNS" ]; do
  log="$LOGS/run-$i.log"
  if node "$HERE/run.ts" >"$log" 2>&1; then
    pass=$((pass + 1))
    verdict=PASS
  else
    fail=$((fail + 1))
    verdict=FAIL
  fi
  turns=$(grep -c '^  tick ' "$log" || true)
  printf 'run %-3s %-4s  turns=%-3s  %s\n' "$i" "$verdict" "$turns" "$log"
  i=$((i + 1))
done

echo
echo "converged $pass / $RUNS  (failed $fail)"
[ "$fail" -eq 0 ]
