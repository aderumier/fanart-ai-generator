#!/usr/bin/env bash
# Launches your real Google Chrome with a debugging port so the automation can
# attach to it. Log into Gemini in THIS window (Google allows it because the
# browser isn't automation-controlled). Leave it open, then run the app.
#
# Stopping this script (Ctrl+C) also shuts the launched Chrome down.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

PORT="${1:-9222}"
PROFILE="$DIR/.gemini-chrome"
mkdir -p "$PROFILE"

echo "Starting Chrome on debug port $PORT with profile $PROFILE"
echo "→ Log into Gemini in the window that opens, then leave it open."
echo "  Press Ctrl+C here to close Chrome."

# Run Chrome in the background so we keep control and can shut it down on exit.
google-chrome \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://gemini.google.com/app" &
CHROME_PID=$!

# On Ctrl+C / TERM, close the Chrome we launched. We target our own instance by
# PID and, as a fallback for Chrome's launcher forking off the real process, by
# the unique profile dir — so Chrome windows on other profiles are never touched.
cleanup() {
  kill "$CHROME_PID" 2>/dev/null || true
  pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null || true
}
trap cleanup INT TERM

# Block until Chrome exits (or until a signal triggers cleanup above).
wait "$CHROME_PID" 2>/dev/null || true
