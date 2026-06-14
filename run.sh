#!/usr/bin/env bash
# Run geminibatch with your installed Node.js, passing arguments through.
#
# Examples:
#   ./run.sh                         (local mode: process ./images)
#   ./run.sh --system dos            (system mode)
#   ./run.sh --system dos --limit 10
#
# Requires Node.js installed and `npm install` run once.
# Launch Chrome first with ./start-chrome.sh, then run this.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/index.js" "$@"
