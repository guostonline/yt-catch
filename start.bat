@echo off
setlocal enabledelayedexpansion
title Catch - YouTube Downloader

cd /d "%~dp0"

set "PORT=8765"

:: Detect Python
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PYTHON=python"
) else (
    where py >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        set "PYTHON=py"
    ) else (
        echo [ERROR] Python 3 is required.
        echo Please install Python 3.10+ from https://www.python.org/downloads/
        echo (Make sure to check "Add Python to PATH" during installation)
        pause
        exit /b 1
    )
)

:: Create virtual environment if missing
if not exist ".venv" (
    echo [*] Creating virtual environment (.venv)...
    %PYTHON% -m venv .venv
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

:: Activate virtualenv
call .venv\Scripts\activate.bat

:: Install / verify dependencies
echo [*] Checking dependencies...
python -c "import fastapi, uvicorn, yt_dlp, yt_dlp_ejs, mutagen" >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [*] Installing dependencies (first run only)...
    python -m pip install -q --upgrade pip
    python -m pip install -q -r requirements.txt
)

:: Check ffmpeg
where ffmpeg >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] WARNING: ffmpeg was not found.
    echo     Video+audio merging and MP3 conversion will fail without ffmpeg.
    echo     Install with: winget install Gyan.FFmpeg
    echo.
)

:: Launch browser in background
start "" "http://127.0.0.1:%PORT%"

echo.
echo ==============================================
echo   Catch is running at http://127.0.0.1:%PORT%
echo   Keep this window open. Press Ctrl+C to stop.
echo ==============================================
echo.

python -m uvicorn server.app:app --host 127.0.0.1 --port %PORT%
pause
