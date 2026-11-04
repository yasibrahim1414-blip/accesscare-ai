#!/bin/sh
# AccessCare AI — runs the downloaded app on this computer only (http://localhost:8000).
# Needs Python 3 (built into Linux; on a Mac the first run may offer to install it). Close this window to stop.
cd "$(dirname "$0")/app" || exit 1
( sleep 1; (command -v open >/dev/null && open "http://localhost:8000/") || (command -v xdg-open >/dev/null && xdg-open "http://localhost:8000/") ) &
echo "AccessCare AI is running at http://localhost:8000/  (close this window to stop)"
exec python3 -m http.server 8000 --bind 127.0.0.1
