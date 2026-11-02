#!/usr/bin/env bash
# Catch — start the local app
set -euo pipefail

cd "$(dirname "$0")"

# Finder launches have a minimal PATH; make Homebrew and local bins reachable on macOS and Linux.
export PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:$PATH"

PYTHON="${PYTHON:-python3}"
PORT="${PORT:-8765}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3 is required. Install it from python.org or with: brew install python"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "→ Creating virtual environment…"
  "$PYTHON" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

if ! python -c "import fastapi, uvicorn, yt_dlp, yt_dlp_ejs, mutagen" >/dev/null 2>&1; then
  echo "→ Installing dependencies (first run only)…"
  python -m pip install -q --upgrade pip
  python -m pip install -q -r requirements.txt
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "⚠  ffmpeg was not found. Video+audio merging and MP3 conversion will fail."
  echo "   Install it with: brew install ffmpeg"
fi

URL="http://127.0.0.1:${PORT}"
echo ""
echo "  Catch is running at ${URL}"
echo "  Press Ctrl+C to stop."
echo ""

# Open the browser once the server is up (macOS / Linux)
if command -v open >/dev/null 2>&1; then
  ( sleep 1.4; open "$URL" >/dev/null 2>&1 || true ) &
elif command -v xdg-open >/dev/null 2>&1; then
  ( sleep 1.4; xdg-open "$URL" >/dev/null 2>&1 || true ) &
fi

exec python -m uvicorn server.app:app --host 127.0.0.1 --port "$PORT"
