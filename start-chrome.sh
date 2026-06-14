#!/usr/bin/env bash
# Launches your real Google Chrome with a debugging port so the automation can
# attach to it. Log into Gemini in THIS window (Google allows it because the
# browser isn't automation-controlled). Leave it open, then run `npm start`.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

PORT="${1:-9222}"
PROFILE="$DIR/.gemini-chrome"
mkdir -p "$PROFILE"

echo "Starting Chrome on debug port $PORT with profile $PROFILE"
echo "→ Log into Gemini in the window that opens, then leave it open."

exec google-chrome \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://gemini.google.com/app"
