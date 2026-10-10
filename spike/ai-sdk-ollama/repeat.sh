#!/usr/bin/env bash
# Repeat the spike decision N times against one model and tally how often the
# model emits STRUCTURED tool calls vs. leaking them as plain text.
# usage: spike/ai-sdk-ollama/repeat.sh <model> [n]
set -u
model="${1:?model required}"
n="${2:-5}"
pass=0
for i in $(seq 1 "$n"); do
  out=$(OLLAMA_MODEL="$model" node spike/ai-sdk-ollama/run.ts 2>/dev/null)
  if printf '%s' "$out" | grep -q 'real Scene nodes'; then
    pass=$((pass + 1))
    verdict=OK
  else
    verdict=NO-TOOL-CALL
  fi
  ms=$(printf '%s' "$out" | grep -o 'elapsed: [0-9]*ms')
  printf '%2d  %-14s %s\n' "$i" "$verdict" "$ms"
done
printf 'structured tool calls: %d/%d  model=%s\n' "$pass" "$n" "$model"
