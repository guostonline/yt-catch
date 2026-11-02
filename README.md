# Catch

A beautiful, local YouTube downloader — video up to 8K, audio, playlists, subtitles, SponsorBlock and more. No ads, no accounts, no cloud. Everything runs on your Mac, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org).

![status](https://img.shields.io/badge/runs-locally-a78bfa) ![python](https://img.shields.io/badge/python-3.10%2B-f472b6) ![yt--dlp](https://img.shields.io/badge/yt--dlp-latest-fbbf24)

---

## One-line install

**macOS (Apple Silicon & Intel) and Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/guostonline/yt-catch/main/install.sh | bash
```

**Windows 10 / 11 (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/guostonline/yt-catch/main/install.ps1 | iex
```

The installer clones Catch into `~/.catch`, sets up its virtual environment, checks for Python, git and ffmpeg, and creates a launcher at `~/.local/bin/catch`. Then start it with:
```bash
catch
```

If your shell can't find `catch`, add `~/.local/bin` to your PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## Quick start

### macOS (Apple Silicon & Intel)
Double-click **`start.command`** in Finder, or run from Terminal:
```bash
./run.sh
```

### Windows (10 / 11)
Double-click **`start.bat`** in File Explorer, or run in Command Prompt / PowerShell:
```cmd
start.bat
```

### Linux (Ubuntu, Debian, Fedora, Arch)
Make executable and run:
```bash
chmod +x run.sh
./run.sh
```

Catch will automatically set up the virtual environment, install requirements, and open **http://127.0.0.1:8765** in your default browser.

---

## Installation & Prerequisites

| Requirement | macOS (Apple Silicon & Intel) | Windows | Linux (Ubuntu / Debian) |
| --- | --- | --- | --- |
| **Python 3.10+** | `brew install python` | `winget install Python.Python.3.12` *(check "Add to PATH")* | `sudo apt install python3 python3-venv python3-pip` |
| **ffmpeg** *(merging & audio)* | `brew install ffmpeg` | `winget install Gyan.FFmpeg` | `sudo apt install ffmpeg` |
| **Node.js** *(recommended)* | `brew install node` | `winget install OpenJS.NodeJS` | `sudo apt install nodejs` |

> **Note for macOS:** Homebrew automatically configures the correct binary paths whether you are on **Apple Silicon** (`/opt/homebrew/bin`) or **Intel** (`/usr/local/bin`). Catch handles both seamlessly.

`yt-dlp` and its JavaScript helper (`yt-dlp-ejs`) are installed automatically into `.venv`. Keep them fresh, YouTube changes often:

```bash
.venv/bin/pip install -U yt-dlp yt-dlp-ejs
```

---

## What you can do

**Video**
- Best available, or pin a quality: 8K / 4K / 2K / 1080p / 720p / 480p / 360p
- Container: Auto, MP4, MKV, WEBM
- Codec preference: Best, H.264 (maximum compatibility), VP9, AV1
- Trim a section (`start` / `end`) without downloading the whole thing

**Audio**
- MP3, M4A, Opus, FLAC, WAV — or keep the original stream
- Bitrate presets up to 320 kbps
- Cover art and metadata embedded automatically

**Playlists & batches**
- Whole playlists with an optional folder per playlist
- Item ranges like `1-10, 15, 20-30`
- Numbers and titles in filenames

**Extras**
- Subtitles (manual + auto-generated), any language, as `.srt` or embedded
- Embedded thumbnails, metadata, and chapter markers
- SponsorBlock: remove sponsor segments or mark them as chapters
- Separate thumbnail file
- Skip-already-downloaded archive
- Filename templates, speed limit, proxy, parallel fragments, retries
- Cookies from a file or directly from Chrome / Safari / Firefox / Edge / Brave

**Queue**
- Live progress, speed and ETA over Server-Sent Events
- Cancel mid-download, reveal in Finder, save individual files
- History survives while the server is running; files land in `downloads/`

---

## Using cookies (age-restricted / private / members-only videos)

YouTube sometimes asks for a sign-in check. Two options in **Advanced**:

1. **Cookies from browser** — pick Chrome or Safari while you're signed in to YouTube.
   - On macOS, yt-dlp needs Full Disk Access for your terminal to read Safari/Chrome data.
   - Chrome must be fully quit for its cookie database to be readable.
2. **Cookies file** — export `cookies.txt` with a browser extension, then paste the path.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| “Sign in to confirm you're not a bot” | Use browser cookies (above), or update yt-dlp. |
| Merging fails / no MP3 | Install ffmpeg: `brew install ffmpeg`. |
| Some qualities are missing, or “n challenge” warnings appear | Install Node (`brew install node`) and restart Catch. The app auto-detects it; `yt-dlp-ejs` provides the challenge solver. |
| “Requested format is not available” | Update yt-dlp (`pip install -U yt-dlp`). Catch now falls back to the best available format instead of failing. |
| HTTP 429 | You're rate-limited — wait, or set a proxy under Advanced. |
| Safari cookies error | Grant Full Disk Access to your terminal in System Settings → Privacy & Security. |
| macOS won’t open `start.command` | Right-click → Open once, or run `./run.sh` from Terminal. |
| Anything breaks after a YouTube change | `.venv/bin/pip install -U yt-dlp` and restart. |

---

## Project layout

```
yt-catch/
├── server/app.py      FastAPI + yt-dlp job engine (SSE progress, queue)
├── web/
│   ├── index.html     UI structure
│   ├── styles.css     design system (dark glass, aurora)
│   └── app.js         client logic
├── downloads/         your files
├── run.sh             one-command launcher
├── start.command      double-click launcher (macOS)
└── requirements.txt
```

Port changed? `PORT=9000 ./run.sh`.

---

## A note on use

Catch is a local tool built on open-source software. Download only content you own or have permission to keep, and respect the terms of service of the sites you use. It is not affiliated with YouTube.
