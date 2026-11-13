#!/bin/bash
# Watcher for the bare-metal acceptance driver: exits when the driver process
# is gone and prints the final report + last driver log lines.
ROOT="$HOME/deepseek/h3-bare-metal"
while pgrep -f bare-metal-run.mjs >/dev/null 2>&1; do
  sleep 60
done
echo "=== driver exited at $(date -u +%FT%TZ) ==="
echo "--- bare-report.json ---"
cat "$ROOT/bare-report.json" 2>/dev/null
echo
echo "--- last 25 driver log lines ---"
tail -25 "$ROOT/bare-driver.log" 2>/dev/null
