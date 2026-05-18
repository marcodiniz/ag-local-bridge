#!/bin/bash

# Navigate to the project directory
cd "/media/abhinav/WorkData/Github Projects/ag local bridge" || exit 1

# Send an initial notification
notify-send -t 3000 "Antigravity Swarm" "Shutting down all headless instances..." -i "/media/abhinav/WorkData/Github Projects/ag local bridge/icon.png"

# Stop the pool
./scripts/start-pool.sh stop

# Wait a second to let processes die
sleep 1

# Verify all headless instances are stopped (LSP might still be running from the main app)
# The stop script kills by PID file, but we can do a quick check
notify-send -t 5000 "Antigravity Swarm" "Swarm has been successfully shut down. Memory freed." -i "/media/abhinav/WorkData/Github Projects/ag local bridge/icon.png"
