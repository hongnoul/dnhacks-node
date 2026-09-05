#!/bin/bash
# Waits for the first real phone node (non-fake01) heartbeat/clip
for i in $(seq 1 600); do
  if grep -v fake01 events.jsonl 2>/dev/null | grep -q heartbeat; then
    echo "JCODE_CHECKPOINT {\"message\":\"Real phone node joined the mesh\"}"
    grep -v fake01 events.jsonl | tail -3
    exit 0
  fi
  sleep 2
done
echo "timeout: no phone joined in 20 min"
exit 1
