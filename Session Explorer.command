#!/bin/zsh
# Double-click to open Session Explorer (or reuse it if it's already running).
cd "$(dirname "$0")"
if curl -s -o /dev/null http://127.0.0.1:8765/api/stats; then
  open http://127.0.0.1:8765
else
  python3 server.py
fi
