#!/bin/bash

# Navigate to the project directory
cd "/media/abhinav/WorkData/Github Projects/ag local bridge" || exit 1

# Send an initial notification
notify-send -t 3000 "Antigravity Swarm" "Launching 4 headless instances..." -i "/media/abhinav/WorkData/Github Projects/ag local bridge/icon.png"

# Start the pool (this is idempotent, it's safe to run if already running)
./scripts/start-pool.sh start

# Wait a couple of seconds for processes to initialize
sleep 3

# Count running headless instances (filter out LSP-only)
RUNNING_COUNT=$(ps aux | grep "language_server" | grep -v "enable_lsp" | grep -v grep | wc -l)

if [ "$RUNNING_COUNT" -gt 0 ]; then
  notify-send -t 5000 "Antigravity Swarm" "Swarm is live! $RUNNING_COUNT instances running in the background." -i "/media/abhinav/WorkData/Github Projects/ag local bridge/icon.png"
else
  notify-send -u critical "Antigravity Swarm" "Failed to start instances. Check terminal logs." -i error
fi
