#!/bin/bash
# Retry wrapper for the bare-metal driver: transient network drops make the
# engine fetch raise "run again to resume" (its designed contract), and the
# driver is idempotent (disk truth per step). Relaunch while the disk keeps
# making progress; STOP if a relaunch shows zero forward progress twice in a
# row (AGENTS.md: no infinite retry of the same failure).
ROOT="$HOME/deepseek/h3-bare-metal"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/source-shards-done"
MAX_ATTEMPTS=12

shards_done() {
  # source shards are deleted after conversion, so count the converter's own
  # truth file (dit/convert_state.json), not the source dir.
  grep -c 'model-000[0-9]*-of-00012.safetensors": {' "$ROOT/bare-models/dit/convert_state.json" 2>/dev/null || echo 0
}

attempt=0
prev=$(cat "$STATE" 2>/dev/null || echo -1)
stall=0
while [ $attempt -lt $MAX_ATTEMPTS ]; do
  # zero-alive precondition (race incident rule)
  while pgrep -f bare-metal-run.mjs >/dev/null 2>&1; do sleep 20; done
  attempt=$((attempt+1))
  echo "[watch-retry $(date -u +%FT%TZ)] attempt $attempt (prev shards=$prev)"
  ( cd "$REPO" && node scripts/bare-metal-run.mjs >> "$ROOT/driver.out" 2>&1 )
  rc=$?
  if grep -q "BARE-METAL ACCEPTANCE PASS" "$ROOT/driver.out"; then
    echo "[watch-retry $(date -u +%FT%TZ)] PASS detected, exiting 0"
    exit 0
  fi
  cur=$(shards_done)
  echo "$cur" > "$STATE"
  echo "[watch-retry $(date -u +%FT%TZ)] driver rc=$rc, shards on disk: $prev -> $cur"
  if [ "$cur" -le "$prev" ]; then
    stall=$((stall+1))
    if [ $stall -ge 2 ]; then
      echo "[watch-retry $(date -u +%FT%TZ)] ZERO forward progress twice in a row — STOP for human triage"
      exit 2
    fi
  else
    stall=0
  fi
  prev=$cur
  sleep 30
done
echo "[watch-retry $(date -u +%FT%TZ)] MAX_ATTEMPTS reached without PASS — STOP"
exit 3
