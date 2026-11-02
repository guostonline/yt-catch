"""Catch — a local, good-looking YouTube (and 1000+ site) downloader.

Backend: FastAPI + yt-dlp. Everything runs on your machine.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

# --------------------------------------------------------------------------- #
# Paths & constants
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = BASE_DIR / "web"
DOWNLOAD_DIR = Path(
    os.environ.get("CATCH_DOWNLOAD_DIR", BASE_DIR / "downloads")
).expanduser().resolve()
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
TMP_DIR = DOWNLOAD_DIR / ".tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_FILE = DOWNLOAD_DIR / ".archive.txt"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
MEDIA_EXTS = {
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v",
    ".mp3", ".m4a", ".opus", ".flac", ".wav", ".ogg", ".aac",
}
TEMPLATES = {
    "title": "%(title)s.%(ext)s",
    "title_id": "%(title)s [%(id)s].%(ext)s",
    "channel_title": "%(uploader)s - %(title)s.%(ext)s",
    "date_title": "%(upload_date>%Y-%m-%d)s - %(title)s.%(ext)s",
}

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
PLACEHOLDER_TITLE = "Fetching video…"
EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="catch-worker")
JOB_SEQ = 0

app = FastAPI(title="Catch", version="1.0.0", docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def clean_message(err: Any) -> str:
    msg = ANSI_RE.sub("", str(err or "")).strip()
    msg = msg.replace("ERROR: ", "")
    lines = [ln.strip() for ln in msg.splitlines() if ln.strip()]
    if not lines:
        return "Something went wrong."
    # yt-dlp sometimes prints a wall of text; the last lines are the useful ones
    text = lines[-1] if len(lines) > 4 else " ".join(lines)
    fixes = {
        "Sign in to confirm": "YouTube wants a sign-in check. In Advanced options, use your browser cookies (Chrome/Safari) or a cookies.txt file.",
        "confirm you're not a bot": "YouTube wants a sign-in check. In Advanced options, use your browser cookies (Chrome/Safari) or a cookies.txt file.",
        "This video is unavailable": "This video is unavailable — it may be private, region-locked or removed.",
        "Private video": "This video is private.",
        "members-only": "This video is members-only, so it needs cookies from a member account.",
        "Unsupported URL": "That link isn't supported.",
        "is not a valid URL": "That doesn't look like a valid link.",
        "HTTP Error 429": "You're being rate-limited by the site. Wait a bit, or set a proxy in Advanced options.",
        "No such file or directory": "A file path was not found. Check your cookies file path.",
    }
    for needle, hint in fixes.items():
        if needle.lower() in text.lower():
            return f"{hint} ({text})" if text.lower() not in hint.lower() else hint
    return text[:600]


def clean_url(raw: str) -> str:
    url = (raw or "").strip().strip("<>\"'")
    if not url:
        raise ValueError("Paste a video or playlist link first.")
    if re.fullmatch(r"[\w-]{11}", url):
        return f"https://www.youtube.com/watch?v={url}"
    if re.match(r"^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)/", url, re.I):
        url = "https://" + url
    if not re.match(r"^https?://", url, re.I):
        if "." in url:
            url = "https://" + url
        else:
            raise ValueError("That doesn't look like a link.")
    return url


def has_video_id(url: str) -> bool:
    try:
        from urllib.parse import parse_qs, urlparse

        p = urlparse(url)
        host = (p.hostname or "").lower()
        if host.endswith("youtu.be"):
            return bool(p.path.strip("/"))
        if "v" in parse_qs(p.query):
            return True
        return bool(re.match(r"^/(shorts|embed|live|v)/", p.path))
    except Exception:
        return False


def human_bytes(n: float | None) -> str:
    if not n:
        return ""
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    n = float(n)
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return f"{n:.0f} {units[i]}" if i == 0 or n >= 10 else f"{n:.1f} {units[i]}"


def parse_timecode(value: str) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    parts = value.split(":")
    if len(parts) > 3:
        raise ValueError("Use seconds, mm:ss or hh:mm:ss for trimming.")
    total = 0.0
    for part in parts:
        if part.strip() == "":
            raise ValueError("Invalid trim time.")
        total = total * 60 + float(part)
    return total


COMMON_BIN_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    str(Path.home() / ".local/bin"),
    str(Path.home() / "bin"),
)


def _which_binary(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for folder in COMMON_BIN_DIRS:
        candidate = Path(folder) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def detect_js_runtimes() -> dict[str, dict[str, str]]:
    """JavaScript runtimes yt-dlp can use to solve YouTube's player challenges.

    Ordered by yt-dlp's own priority (deno, node, quickjs, bun). When the app is
    launched from Finder the PATH is minimal, so we also probe the usual install
    folders and hand yt-dlp an explicit path.
    """
    runtimes: dict[str, dict[str, str]] = {}
    for name in ("deno", "node", "quickjs", "bun"):
        path = _which_binary(name)
        if path:
            runtimes[name] = {"path": path}
    return runtimes


JS_RUNTIMES = detect_js_runtimes()
FFMPEG_PATH = _which_binary("ffmpeg")


def ensure_on_path(binary_path: str | None) -> None:
    """Make detected binaries visible to child processes (yt-dlp asks `which`).

    Launched from Finder, PATH misses Homebrew, so ffmpeg/ffprobe look absent
    even though they're installed.
    """
    if not binary_path:
        return
    folder = str(Path(binary_path).parent)
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    if folder not in parts:
        os.environ["PATH"] = os.pathsep.join(parts + [folder])


ensure_on_path(FFMPEG_PATH)
for _config in JS_RUNTIMES.values():
    ensure_on_path(_config.get("path"))


def js_runtime_params() -> dict[str, dict[str, str]]:
    return {name: dict(config) for name, config in JS_RUNTIMES.items()}


def parse_rate_limit(value: str) -> int:
    """Turn '2M' / '500K' / '1500000' into bytes per second."""
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KMG]?)", value.strip(), re.I)
    if not match:
        raise ValueError("Speed limit should look like 2M or 500K.")
    number, suffix = match.groups()
    multiplier = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}[suffix.upper()]
    return max(1, int(float(number) * multiplier))


def sanitize_template(template: str, playlist: bool) -> str:
    template = (template or TEMPLATES["title"]).replace("\\", "/").strip()
    template = template.lstrip("/")
    parts = [p for p in template.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        template = TEMPLATES["title"]
    template = "/".join(parts) or TEMPLATES["title"]
    if not re.search(r"%\(ext\)s$", template) and "%(ext" not in template:
        template += ".%(ext)s"
    if playlist and "%(playlist" not in template:
        template = "%(playlist_title,playlist_id|Playlist)s/%(playlist_index)02d - " + template
    return template


def fmt_size_from_tbr(fmt: dict, duration: float | None) -> int | None:
    if fmt.get("filesize"):
        return int(fmt["filesize"])
    if fmt.get("filesize_approx"):
        return int(fmt["filesize_approx"])
    tbr = fmt.get("tbr") or fmt.get("bitrate")
    if tbr and duration:
        return int(tbr * 1000 / 8 * duration)
    return None


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    files = []
    for p in job.get("files", []):
        try:
            st = os.stat(p)
            files.append({"name": os.path.basename(p), "size": st.st_size})
        except OSError:
            files.append({"name": os.path.basename(p), "size": 0})
    return {
        "id": job["id"],
        "url": job["url"],
        "mode": job["mode"],
        "title": job["title"],
        "thumbnail": job.get("thumbnail") or "",
        "duration": job.get("duration") or 0,
        "channel": job.get("channel") or "",
        "kind": job.get("kind") or "video",
        "status": job["status"],
        "progress": round(float(job.get("progress") or 0), 2),
        "speed": job.get("speed"),
        "eta": job.get("eta"),
        "downloaded": job.get("downloaded") or 0,
        "total": job.get("total") or 0,
        "item_index": job.get("item_index") or 0,
        "item_count": job.get("item_count") or 0,
        "filename": job.get("filename") or "",
        "files": files,
        "error": job.get("error"),
        "created": job.get("created"),
        "started": job.get("started"),
        "finished": job.get("finished"),
        "quality": job.get("quality"),
        "note": job.get("note") or "",
    }


def snapshot() -> dict[str, Any]:
    with JOBS_LOCK:
        jobs = [public_job(j) for j in JOBS.values()]
    jobs.sort(key=lambda j: j.get("created") or 0, reverse=True)
    done = [j for j in jobs if j["status"] == "completed"]
    total_bytes = sum(f["size"] for j in done for f in j["files"])
    return {
        "jobs": jobs,
        "stats": {
            "active": sum(1 for j in jobs if j["status"] in ("queued", "fetching", "downloading", "processing")),
            "completed": len(done),
            "bytes": total_bytes,
            "bytes_label": human_bytes(total_bytes),
            "ytdlp": yt_dlp.version.__version__,
        },
        "now": time.time(),
    }


# --------------------------------------------------------------------------- #
# Info extraction
# --------------------------------------------------------------------------- #

def _extract_info(url: str) -> dict[str, Any]:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "noplaylist": has_video_id(url),
        "socket_timeout": 25,
        "retries": 3,
        "cachedir": False,
        "ignoreerrors": "only_download",
        "js_runtimes": js_runtime_params(),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise ValueError("Couldn't read that link. Try another one.")

    is_playlist = info.get("_type") == "playlist"
    duration = info.get("duration") or 0

    # ---- formats -------------------------------------------------------- #
    videos: dict[int, dict[str, Any]] = {}
    audios: dict[str, dict[str, Any]] = {}
    for f in info.get("formats") or []:
        if not f.get("format_id") or f.get("ext") == "mhtml":
            continue
        vcodec = (f.get("vcodec") or "none").lower()
        acodec = (f.get("acodec") or "none").lower()
        size = fmt_size_from_tbr(f, duration)
        height = f.get("height")
        width = f.get("width")
        # Quality = shorter side, so portrait/Shorts report 1080p not 1920p
        # and match yt-dlp's own `res:` sort order.
        res = min(width, height) if width and height else height
        if vcodec != "none" and res:
            cur = videos.get(int(res))
            score = ((f.get("fps") or 0), (f.get("tbr") or 0), 1 if acodec != "none" else 0)
            if cur is None or score > cur["_score"]:
                videos[int(res)] = {
                    "height": int(res),
                    "fps": f.get("fps"),
                    "ext": f.get("ext"),
                    "vcodec": f.get("vcodec"),
                    "portrait": bool(width and height and height > width),
                    "hdr": bool(f.get("dynamic_range") and f.get("dynamic_range") != "SDR"),
                    "size": size,
                    "size_label": human_bytes(size),
                    "_score": score,
                }
        elif vcodec == "none" and acodec != "none":
            key = str(f.get("ext") or "audio")
            cur = audios.get(key)
            score = (f.get("abr") or 0, f.get("tbr") or 0)
            if cur is None or score > cur["_score"]:
                audios[key] = {
                    "ext": key,
                    "abr": f.get("abr"),
                    "size": size,
                    "size_label": human_bytes(size),
                    "_score": score,
                }

    quality_options = [
        {k: v for k, v in v.items() if k != "_score"}
        for v in sorted(videos.values(), key=lambda x: x["height"], reverse=True)
    ]
    if info.get("height") and not quality_options:
        fallback_h = info.get("height")
        fallback_w = info.get("width")
        fallback_res = min(fallback_w, fallback_h) if fallback_w and fallback_h else fallback_h
        quality_options.append({
            "height": int(fallback_res),
            "fps": info.get("fps"),
            "ext": info.get("ext"),
            "vcodec": info.get("vcodec"),
            "portrait": bool(fallback_w and fallback_h and fallback_h > fallback_w),
            "hdr": False,
            "size": None,
            "size_label": "",
        })

    # ---- subtitles ------------------------------------------------------ #
    subs: dict[str, dict[str, Any]] = {}
    for source, auto in (("subtitles", False), ("automatic_captions", True)):
        for code, tracks in (info.get(source) or {}).items():
            if not tracks:
                continue
            name = tracks[0].get("name") or code
            if code in subs and subs[code]["auto"] <= auto:
                continue
            subs[code] = {"code": code, "name": name, "auto": auto}
    subtitles = sorted(subs.values(), key=lambda s: (s["auto"], s["code"]))
    # A few friendly defaults first
    priority = {"en": 0, "en-US": 1, "en-GB": 2}
    subtitles.sort(key=lambda s: (priority.get(s["code"], 99), s["auto"], s["code"]))

    entries = []
    if is_playlist:
        for i, e in enumerate(info.get("entries") or [], start=1):
            if not e:
                continue
            thumb = e.get("thumbnail")
            if not thumb:
                thumbs = e.get("thumbnails") or []
                thumb = thumbs[-1].get("url") if thumbs else ""
            entries.append({
                "index": i,
                "id": e.get("id"),
                "title": e.get("title") or f"Video {i}",
                "duration": e.get("duration") or 0,
                "thumbnail": thumb or "",
                "url": e.get("url") or e.get("webpage_url") or "",
            })
            if len(entries) >= 120:
                break

    thumb = info.get("thumbnail")
    if not thumb and entries:
        thumb = entries[0]["thumbnail"]

    return {
        "kind": "playlist" if is_playlist else "video",
        "id": info.get("id"),
        "title": info.get("title") or ("Playlist" if is_playlist else "Untitled"),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "channel_url": info.get("channel_url") or "",
        "duration": duration,
        "thumbnail": thumb or "",
        "view_count": info.get("view_count"),
        "upload_date": info.get("upload_date"),
        "live_status": info.get("live_status"),
        "webpage_url": info.get("webpage_url") or url,
        "description": (info.get("description") or "")[:280],
        "is_live": bool(info.get("is_live")),
        "playlist_count": info.get("playlist_count") or len(entries) if is_playlist else 0,
        "entries": entries,
        "has_more_entries": bool(is_playlist and (info.get("playlist_count") or len(entries)) > len(entries)),
        "formats": {
            "video": quality_options,
            "audio": [{k: v for k, v in a.items() if k != "_score"} for a in audios.values()],
        },
        "subtitles": subtitles,
        "default_playlist": is_playlist,
        "trim_supported": not is_playlist,
    }


@app.get("/api/health")
async def health():
    ffmpeg = FFMPEG_PATH
    try:
        import yt_dlp_ejs  # noqa: F401
        ejs = getattr(yt_dlp_ejs, "version", True)
    except Exception:  # noqa: BLE001
        ejs = None
    return {
        "ok": True,
        "ytdlp": yt_dlp.version.__version__,
        "ffmpeg": bool(ffmpeg),
        "ffmpeg_path": ffmpeg or "",
        "js_runtimes": sorted(JS_RUNTIMES),
        "ejs": str(ejs) if ejs else "",
        "download_dir": str(DOWNLOAD_DIR),
        "python": sys.version.split()[0],
    }


@app.get("/api/info")
async def info(url: str, request: Request):
    try:
        clean = clean_url(url)
        data = await asyncio.wait_for(run_in_threadpool(_extract_info, clean), timeout=90)
        return data
    except asyncio.TimeoutError:
        raise HTTPException(504, "That link took too long to read. Check your connection and try again.")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, clean_message(exc))


# --------------------------------------------------------------------------- #
# Download jobs
# --------------------------------------------------------------------------- #

class DownloadOptions(BaseModel):
    url: str
    mode: str = "video"
    quality: str = "best"
    container: str = "auto"
    codec: str = "any"
    audio_format: str = "mp3"
    audio_quality: str = "320"
    playlist: bool = False
    playlist_items: str = ""
    filename_template: str = "title"
    custom_template: str = ""
    subtitles: bool = False
    sub_langs: str = "en"
    auto_subs: bool = False
    embed_subs: bool = False
    embed_thumbnail: bool = True
    embed_metadata: bool = True
    embed_chapters: bool = True
    sponsorblock: str = "none"
    thumbnail_file: bool = False
    trim_start: str = ""
    trim_end: str = ""
    rate_limit: str = ""
    proxy: str = ""
    cookies_file: str = ""
    cookies_browser: str = ""
    concurrent_fragments: int = Field(default=4, ge=1, le=16)
    retries: int = Field(default=10, ge=0, le=50)
    archive: bool = False
    playlist_folder: bool = True
    title: str = ""
    thumbnail: str = ""
    channel: str = ""
    duration: float = 0
    kind: str = "video"


def build_format_selector(o: DownloadOptions) -> str:
    if o.mode == "audio":
        return "bestaudio/best"
    codec = o.codec
    if codec == "h264":
        return "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b"
    if codec == "vp9":
        return "bv*[vcodec^=vp9]+ba/bv*+ba/b"
    if codec == "av1":
        return "bv*[vcodec^=av01]+ba/bv*+ba/b"
    # Auto/MP4: prefer an MP4 video + M4A audio pair so the merged file is a
    # universally playable .mp4; fall back to whatever the site actually has.
    if o.container in ("auto", "mp4"):
        return "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
    return "bv*+ba/b"


def build_format_sort(o: DownloadOptions) -> list[str]:
    """Prefer the requested quality without ever failing to find a format.

    `res:N` sorts by the shorter side (so portrait videos pick correctly) and
    never goes above N, which mirrors a "up to 1080p" pick. A hard
    `[height<=N]` filter fails outright when a video lacks that exact tier.
    """
    if o.mode != "video" or o.quality in ("best", "", "0"):
        return []
    try:
        res = int(o.quality)
    except (TypeError, ValueError):
        return []
    return [f"res:{res}"]


def build_ydl_opts(o: DownloadOptions, job: dict[str, Any]) -> dict[str, Any]:
    is_playlist = bool(o.playlist)
    template_key = o.filename_template if o.filename_template in TEMPLATES else "title"
    template = TEMPLATES[template_key]
    if o.filename_template == "custom" and o.custom_template.strip():
        template = o.custom_template.strip()
    template = sanitize_template(template, is_playlist and o.playlist_folder)

    opts: dict[str, Any] = {
        "format": build_format_selector(o),
        "paths": {"home": str(DOWNLOAD_DIR), "temp": str(TMP_DIR)},
        "outtmpl": {"default": template},
        "noplaylist": not is_playlist,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": JobLogger(job),
        "progress_hooks": [make_progress_hook(job)],
        "postprocessor_hooks": [make_pp_hook(job)],
        "retries": o.retries,
        "fragment_retries": o.retries,
        "concurrent_fragment_downloads": o.concurrent_fragments,
        "socket_timeout": 30,
        "overwrites": False,
        "continuedl": True,
        "nopart": False,
        "windowsfilenames": False,
        "ignoreerrors": "only_download" if is_playlist else False,
        "extractor_retries": 3,
        "js_runtimes": js_runtime_params(),
    }

    sort_fields = build_format_sort(o)
    if sort_fields:
        opts["format_sort"] = sort_fields
    if FFMPEG_PATH:
        # Launched from Finder, PATH may not include Homebrew — tell yt-dlp where
        # ffmpeg/ffprobe live so merging and conversion keep working.
        opts["ffmpeg_location"] = FFMPEG_PATH

    if is_playlist and o.playlist_items.strip():
        opts["playlist_items"] = o.playlist_items.strip()

    if o.mode == "video" and o.container != "auto":
        opts["merge_output_format"] = o.container

    # ---- subtitles ----
    langs = [x.strip() for x in (o.sub_langs or "en").replace(";", ",").split(",") if x.strip()]
    if o.subtitles:
        opts["writesubtitles"] = True
        opts["subtitleslangs"] = langs or ["en"]
        opts["subtitlesformat"] = "srt/best"
    if o.auto_subs:
        opts["writeautomaticsub"] = True
        opts["subtitleslangs"] = langs or ["en"]
        if "subtitlesformat" not in opts:
            opts["subtitlesformat"] = "srt/best"

    if o.thumbnail_file or o.embed_thumbnail:
        opts["writethumbnail"] = True

    # ---- trimming ----
    start = parse_timecode(o.trim_start)
    end = parse_timecode(o.trim_end)
    if start is not None and end is not None and end <= start:
        raise ValueError("Trim end must be later than trim start.")
    if o.mode == "video" and not is_playlist and (start or end):
        opts["download_ranges"] = lambda _info, _ydl: [{
            "start_time": start or 0,
            "end_time": end or None,
        }]
        opts["force_keyframes_at_cuts"] = True

    # ---- network ----
    if o.rate_limit.strip():
        opts["ratelimit"] = parse_rate_limit(o.rate_limit)
    if o.proxy.strip():
        proxy = o.proxy.strip()
        if not re.match(r"^(https?|socks[45]h?)://", proxy, re.I):
            raise ValueError("Proxy should start with http:// or socks5://")
        opts["proxy"] = proxy
    if o.cookies_file.strip():
        cookie_path = Path(o.cookies_file.strip()).expanduser()
        if not cookie_path.is_file():
            raise ValueError("Cookies file not found — check the path in Advanced options.")
        opts["cookiefile"] = str(cookie_path)
    if o.cookies_browser.strip():
        opts["cookiesfrombrowser"] = (o.cookies_browser.strip().lower(),)
    if o.archive:
        opts["download_archive"] = str(ARCHIVE_FILE)

    # ---- postprocessors ----
    pps: list[dict[str, Any]] = []
    if is_playlist:
        opts["ignoreerrors"] = "only_download"

    if o.subtitles or o.auto_subs:
        # YouTube only serves vtt/ttml; convert everything to clean .srt
        pps.append({"key": "FFmpegSubtitlesConvertor", "format": "srt", "when": "before_dl"})

    if o.mode == "audio":
        if o.audio_format in {"mp3", "m4a", "opus", "flac", "wav", "aac"}:
            pps.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": o.audio_format,
                "preferredquality": o.audio_quality if o.audio_format in {"mp3", "m4a", "opus", "aac"} else None,
            })
        opts["merge_output_format"] = None

    if o.sponsorblock in {"remove", "mark"} and o.mode == "video":
        pps.append({"key": "SponsorBlock", "categories": "sponsor", "when": "after_filter"})
        if o.sponsorblock == "remove":
            pps.append({
                "key": "ModifyChapters",
                "remove_sponsor_segments": "sponsor",
                "force_keyframes": True,
            })

    if o.embed_subs and (o.subtitles or o.auto_subs):
        pps.append({"key": "FFmpegEmbedSubtitle"})

    add_chapters = o.embed_chapters or o.sponsorblock == "mark"
    if o.embed_metadata or add_chapters:
        pps.append({
            "key": "FFmpegMetadata",
            "add_metadata": o.embed_metadata,
            "add_chapters": add_chapters,
        })

    if o.embed_thumbnail:
        pps.append({
            "key": "EmbedThumbnail",
            "already_have_thumbnail": bool(o.thumbnail_file),
        })

    if pps:
        opts["postprocessors"] = pps

    return opts


class JobLogger:
    """Captures yt-dlp output for the job card + console."""

    def __init__(self, job: dict[str, Any]):
        self.job = job

    def _append(self, level: str, msg: str) -> None:
        msg = ANSI_RE.sub("", str(msg)).strip()
        if not msg:
            return
        with JOBS_LOCK:
            logs = self.job.setdefault("logs", [])
            logs.append(msg)
            del logs[:-60]

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug]"):
            return
        self._append("debug", msg)

    def info(self, msg: str) -> None:
        self._append("info", msg)

    def warning(self, msg: str) -> None:
        self._append("warning", msg)

    def error(self, msg: str) -> None:
        self._append("error", msg)


class Cancelled(Exception):
    pass


def _pct(info: dict[str, Any], frac: float) -> float:
    index = info.get("playlist_index") or 0
    count = info.get("playlist_count") or info.get("n_entries") or 0
    if count and index:
        return max(0.0, min(100.0, ((index - 1) + frac) / count * 100))
    return max(0.0, min(100.0, frac * 100))


def make_progress_hook(job: dict[str, Any]):
    last = {"t": 0.0}

    def hook(d: dict[str, Any]) -> None:
        if job.get("cancel"):
            raise Cancelled()
        status = d.get("status")
        info = d.get("info_dict") or {}
        with JOBS_LOCK:
            if job.get("cancel"):
                raise Cancelled()
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                frac = (done / total) if total else 0
                job["status"] = "downloading"
                job["progress"] = _pct(info, frac)
                job["downloaded"] = done
                job["total"] = total
                job["speed"] = d.get("speed")
                job["eta"] = d.get("eta")
                job["item_index"] = info.get("playlist_index") or 0
                job["item_count"] = info.get("playlist_count") or info.get("n_entries") or 0
                if info.get("title") and info.get("_type") != "playlist":
                    job["title"] = info.get("title") or job["title"]
                if not job.get("thumbnail") and info.get("thumbnail"):
                    job["thumbnail"] = info["thumbnail"]
                job["filename"] = os.path.basename(d.get("filename") or "")
            elif status == "finished":
                job["status"] = "processing"
                job["progress"] = max(job.get("progress") or 0, _pct(info, 1))
                job["speed"] = None
                job["eta"] = None
                job["downloaded"] = job.get("total") or job.get("downloaded") or 0

    return hook


def make_pp_hook(job: dict[str, Any]):
    def hook(d: dict[str, Any]) -> None:
        if job.get("cancel"):
            raise Cancelled()
        if d.get("status") == "started":
            with JOBS_LOCK:
                job["status"] = "processing"
                job["progress"] = max(job.get("progress") or 0, 99)
                job["speed"] = None
                job["eta"] = None
        if d.get("status") == "finished":
            info = d.get("info_dict") or {}
            path = info.get("filepath")
            if path and Path(path).suffix.lower() in MEDIA_EXTS and os.path.exists(path):
                with JOBS_LOCK:
                    files = job.setdefault("files", [])
                    if path not in files:
                        files.append(path)

    return hook


def _collect_files(info: Any) -> list[str]:
    out: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("entries") is not None:
            for entry in node.get("entries") or []:
                walk(entry)
            return
        for key in ("filepath", "_filename"):
            path = node.get(key)
            if path and Path(path).suffix.lower() in MEDIA_EXTS:
                out.append(path)
        for rd in node.get("requested_downloads") or []:
            path = rd.get("filepath")
            if path and Path(path).suffix.lower() in MEDIA_EXTS:
                out.append(path)

    walk(info)
    return out


def _scan_new_files(started: float) -> list[str]:
    found: list[str] = []
    try:
        for path in DOWNLOAD_DIR.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTS:
                continue
            try:
                if path.stat().st_mtime >= started - 1:
                    found.append(str(path))
            except OSError:
                continue
    except OSError:
        pass
    return found


def _run_job(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return

    opts_model: DownloadOptions = job["_options"]

    with JOBS_LOCK:
        if job.get("cancel"):
            job["status"] = "canceled"
            job["finished"] = time.time()
            return
        job["status"] = "fetching"
        job["started"] = time.time()

    started = time.time()

    try:
        ydl_opts = build_ydl_opts(opts_model, job)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(job["url"], download=True)

        if job.get("cancel"):
            raise Cancelled()

        files = _collect_files(info)
        with JOBS_LOCK:
            for path in job.get("files", []):
                if os.path.exists(path) and path not in files:
                    files.append(path)
        if not files:
            files = _scan_new_files(started)
        # de-dupe, keep existing media only
        clean: list[str] = []
        for path in files:
            if os.path.exists(path) and path not in clean and Path(path).suffix.lower() in MEDIA_EXTS:
                clean.append(path)

        # Nothing new was fetched — the archive or an existing file stopped us.
        note = ""
        log_text = " ".join(job.get("logs") or []).lower()
        if "already been recorded in the archive" in log_text:
            note = ("Already in your archive — showing the saved file."
                    if clean else "Already in your archive — skipped.")
        elif not clean and "has already been downloaded" in log_text:
            note = "Already downloaded — file kept."

        with JOBS_LOCK:
            job["files"] = clean
            job["note"] = note
            job["status"] = "completed"
            job["progress"] = 100
            job["speed"] = None
            job["eta"] = 0
            job["finished"] = time.time()
            if clean:
                job["filename"] = os.path.basename(clean[-1])
            if not job.get("title") or job["title"] == PLACEHOLDER_TITLE:
                if info and info.get("title"):
                    job["title"] = info["title"]
                elif clean:
                    job["title"] = Path(clean[-1]).stem
                elif note:
                    job["title"] = "Already downloaded"
    except Cancelled:
        with JOBS_LOCK:
            job["status"] = "canceled"
            job["error"] = None
            job["finished"] = time.time()
            job["speed"] = None
            job["eta"] = None
    except Exception as exc:  # noqa: BLE001
        canceled = bool(job.get("cancel"))
        with JOBS_LOCK:
            job["status"] = "canceled" if canceled else "error"
            job["error"] = None if canceled else clean_message(exc)
            job["finished"] = time.time()
            job["speed"] = None
            job["eta"] = None
        if not canceled:
            print(f"[catch] job {job_id} failed: {clean_message(exc)}", file=sys.stderr)


@app.post("/api/download")
async def start_download(o: DownloadOptions):
    try:
        url = clean_url(o.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    if o.mode not in {"video", "audio"}:
        raise HTTPException(400, "Unknown download mode.")
    if o.quality not in {"best", ""} and not str(o.quality).isdigit():
        raise HTTPException(400, "Unknown quality.")
    if o.container not in {"auto", "mp4", "mkv", "webm"}:
        raise HTTPException(400, "Unknown container.")
    if o.codec not in {"any", "h264", "vp9", "av1"}:
        raise HTTPException(400, "Unknown codec.")
    if o.mode == "video" and o.container == "webm" and o.codec == "h264":
        raise HTTPException(400, "WEBM can't hold H.264. Pick VP9/AV1, or use Auto/MP4.")
    if o.sponsorblock not in {"none", "remove", "mark"}:
        raise HTTPException(400, "Unknown SponsorBlock mode.")
    if o.cookies_browser and o.cookies_browser.lower() not in {
        "chrome", "safari", "firefox", "edge", "brave", "opera", "chromium", "vivaldi", "whale",
    }:
        raise HTTPException(400, "Unknown browser for cookies.")

    # Validate paths / templates up front so users get an instant error
    try:
        build_ydl_opts(o, {"logs": []})
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    global JOB_SEQ
    with JOBS_LOCK:
        JOB_SEQ += 1
        job_id = uuid.uuid4().hex[:12]
        job: dict[str, Any] = {
            "id": job_id,
            "seq": JOB_SEQ,
            "url": clean_url(o.url),
            "mode": o.mode,
            "quality": "audio" if o.mode == "audio" else (o.quality if o.quality != "best" else "Best"),
            "title": o.title or PLACEHOLDER_TITLE,
            "thumbnail": o.thumbnail or "",
            "duration": o.duration or 0,
            "channel": o.channel or "",
            "kind": o.kind or "video",
            "status": "queued",
            "progress": 0,
            "speed": None,
            "eta": None,
            "downloaded": 0,
            "total": 0,
            "item_index": 0,
            "item_count": 0,
            "filename": "",
            "files": [],
            "error": None,
            "created": time.time(),
            "started": None,
            "finished": None,
            "logs": [],
            "cancel": False,
            "_options": o,
        }
        # cap history
        if len(JOBS) > 120:
            for old_id, _ in sorted(JOBS.items(), key=lambda kv: kv[1].get("created") or 0)[:20]:
                if JOBS[old_id]["status"] not in ("queued", "fetching", "downloading", "processing"):
                    JOBS.pop(old_id, None)
        JOBS[job_id] = job
        payload = public_job(job)

    EXECUTOR.submit(_run_job, job_id)
    return payload


@app.get("/api/jobs")
async def list_jobs():
    return snapshot()


@app.get("/api/stream")
async def stream(request: Request):
    async def gen():
        last_sig = None
        while True:
            if await request.is_disconnected():
                break
            data = snapshot()
            sig = json.dumps(
                [{k: j[k] for k in ("id", "status", "progress", "downloaded", "speed", "title", "error", "finished")}
                 for j in data["jobs"]],
                sort_keys=True,
            )
            if sig != last_sig:
                yield f"data: {json.dumps(data)}\n\n"
                last_sig = sig
            else:
                yield ": ping\n\n"
            await asyncio.sleep(0.6)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _get_job(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "That download no longer exists.")
        return job


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = _get_job(job_id)
    with JOBS_LOCK:
        job["cancel"] = True
        if job["status"] == "queued":
            job["status"] = "canceled"
            job["finished"] = time.time()
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "That download no longer exists.")
        if job["status"] in ("queued", "fetching", "downloading", "processing"):
            job["cancel"] = True
            raise HTTPException(409, "Cancel the download before removing it.")
        JOBS.pop(job_id, None)
    return {"ok": True}


@app.delete("/api/jobs")
async def clear_jobs():
    with JOBS_LOCK:
        for key in [k for k, j in JOBS.items() if j["status"] not in
                    ("queued", "fetching", "downloading", "processing")]:
            JOBS.pop(key, None)
    return snapshot()


def _safe_job_file(job_id: str, index: int) -> Path:
    job = _get_job(job_id)
    files = job.get("files") or []
    if index < 0 or index >= len(files):
        raise HTTPException(404, "File not found.")
    path = Path(files[index])
    if not path.is_file():
        raise HTTPException(404, "File was moved or deleted.")
    return path


@app.get("/api/jobs/{job_id}/file/{index}")
async def get_file(job_id: str, index: int):
    path = _safe_job_file(job_id, index)
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")


@app.post("/api/jobs/{job_id}/reveal")
async def reveal_job(job_id: str):
    job = _get_job(job_id)
    files = job.get("files") or []
    target = files[-1] if files else str(DOWNLOAD_DIR)
    _reveal(target)
    return {"ok": True}


def _reveal(path: str) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", path], check=False)
        elif os.name == "nt":
            subprocess.run(["explorer", "/select,", path], check=False)
        else:
            target = path if os.path.isdir(path) else os.path.dirname(path)
            subprocess.run(["xdg-open", target], check=False)
    except Exception:
        pass


@app.post("/api/reveal-downloads")
async def reveal_downloads():
    _reveal(str(DOWNLOAD_DIR))
    return {"ok": True}


@app.get("/api/logs/{job_id}")
async def job_logs(job_id: str):
    job = _get_job(job_id)
    with JOBS_LOCK:
        return {"logs": list(job.get("logs") or [])}


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
