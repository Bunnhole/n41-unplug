#!/usr/bin/env sh
# n41 unplug launcher for macOS and Linux.
# Starts the server with --auto-exit and opens the console in your default browser.
# The server quits on its own about 8 seconds after the last console tab closes.
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
URL="http://localhost:$PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required: https://nodejs.org/" >&2
  exit 1
fi

node server.js --auto-exit --port "$PORT" &
SERVER=$!

i=0
until curl -fs "$URL/api/_meta" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 75 ]; then echo "Server did not start on port $PORT" >&2; kill "$SERVER" 2>/dev/null; exit 1; fi
  sleep 0.2
done

if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "Open $URL in your browser"; fi

wait "$SERVER"
