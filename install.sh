#!/usr/bin/env bash
# Catch — One-line installer for macOS & Linux
# Usage: curl -fsSL https://<your-domain-or-github>/install.sh | bash

set -euo pipefail

APP_NAME="catch"
INSTALL_DIR="${HOME}/.catch"
BIN_DIR="${HOME}/.local/bin"
REPO_URL="${CATCH_REPO_URL:-https://github.com/guostonline/yt-catch.git}"

echo "========================================="
echo "   Installing Catch Video Downloader"
echo "========================================="

# 1. Check for Python 3.10+
if ! command -v python3 >/dev/null 2>&1; then
  echo "[-] Python 3 was not found."
  echo "    Please install Python 3 (3.10 or newer) first:"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "    brew install python"
  else
    echo "    sudo apt install python3 python3-venv python3-pip (Ubuntu/Debian)"
    echo "    sudo dnf install python3 (Fedora)"
  fi
  exit 1
fi

# 2. Check for git
if ! command -v git >/dev/null 2>&1; then
  echo "[-] git is required to download Catch."
  echo "    Please install git and rerun this script."
  exit 1
fi

# 3. Clone or update repository
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[*] Updating existing installation in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --quiet
else
  echo "[*] Downloading Catch to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi

# 4. Set up Python virtual environment
echo "[*] Setting up virtual environment..."
if [ ! -d "$INSTALL_DIR/.venv" ]; then
  python3 -m venv "$INSTALL_DIR/.venv"
fi

"$INSTALL_DIR/.venv/bin/python" -m pip install -q --upgrade pip
"$INSTALL_DIR/.venv/bin/python" -m pip install -q -r "$INSTALL_DIR/requirements.txt"

# 5. Check ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo ""
  echo "[!] Notice: ffmpeg is not installed on your system."
  echo "    Video merging and audio extraction require ffmpeg."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "    Install it via: brew install ffmpeg"
  else
    echo "    Install it via: sudo apt install ffmpeg"
  fi
  echo ""
fi

# 6. Create binary launcher in ~/.local/bin/catch
mkdir -p "$BIN_DIR"
cat << 'EOF' > "$BIN_DIR/catch"
#!/usr/bin/env bash
set -e
INSTALL_DIR="${HOME}/.catch"
exec "${INSTALL_DIR}/run.sh" "$@"
EOF
chmod +x "$BIN_DIR/catch"

# 7. Ensure ~/.local/bin is in PATH instructions
echo ""
echo "========================================="
echo "   Catch installed successfully! 🎉"
echo "========================================="
echo ""
echo "To start Catch, simply run:"
echo "   catch"
echo ""

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "NOTE: Add ~/.local/bin to your PATH if it isn't already:"
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "Add the line above to your ~/.bashrc or ~/.zshrc."
  echo ""
fi
