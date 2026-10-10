#!/usr/bin/env bash
# Measure how often the RunMesh decision loop emits usable structured actions.
# Each run is one decision against the live Ollama model.
set -u
cd "$(dirname "$0")/.."
RUNS="${1:-6}"
LOG=spike/reliability.log
: >"$LOG"
for i in $(seq 1 "$RUNS"); do
  printf '===== run %s =====\n' "$i" >>"$LOG"
  pnpm spike:runmesh >>"$LOG" 2>&1
done
printf 'total runs : %s\n' "$RUNS"
printf 'PASS       : %s\n' "$(grep -c 'all emitted node ids valid: true' "$LOG")"
printf 'no-toolcall: %s\n' "$(grep -c 'none — model returned no tool calls' "$LOG")"
printf 'crashed    : %s\n' "$(grep -c 'ValidationError' "$LOG")"
printf '\nemitted action sequences:\n'
grep -E '^  [0-9]+\. (setState|clickTrigger)' "$LOG" || true
