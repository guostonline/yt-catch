# Catch — One-line installer for Windows
# Usage in PowerShell: irm https://<your-domain-or-github>/install.ps1 | iex

$ErrorActionPreference = "Stop"

$AppName = "catch"
$InstallDir = Join-Path $HOME ".catch"
$BinDir = Join-Path $HOME ".local\bin"
$RepoUrl = if ($env:CATCH_REPO_URL) { $env:CATCH_REPO_URL } else { "https://github.com/guostonline/yt-catch.git" }

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   Installing Catch Video Downloader" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Check Python
$PythonCmd = $null
if (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCmd = "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCmd = "py"
} else {
    Write-Host "[-] Python 3.10+ was not found on your system." -ForegroundColor Red
    Write-Host "    Install via: winget install Python.Python.3.12" -ForegroundColor Yellow
    exit 1
}

# 2. Check Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[-] Git is required to clone Catch." -ForegroundColor Red
    Write-Host "    Install via: winget install Git.Git" -ForegroundColor Yellow
    exit 1
}

# 3. Clone or update
if (Test-Path "$InstallDir\.git") {
    Write-Host "[*] Updating existing installation..." -ForegroundColor Green
    git -C $InstallDir pull --quiet
} else {
    Write-Host "[*] Downloading Catch to $InstallDir..." -ForegroundColor Green
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    git clone --quiet --depth=1 $RepoUrl $InstallDir
}

# 4. Set up venv
Write-Host "[*] Configuring virtual environment..." -ForegroundColor Green
$VenvDir = Join-Path $InstallDir ".venv"
if (-not (Test-Path $VenvDir)) {
    & $PythonCmd -m venv $VenvDir
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
& $VenvPython -m pip install -q --upgrade pip
& $VenvPython -m pip install -q -r (Join-Path $InstallDir "requirements.txt")

# 5. Check ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "[!] Notice: ffmpeg is not found on your system." -ForegroundColor Yellow
    Write-Host "    Install via: winget install Gyan.FFmpeg" -ForegroundColor Yellow
}

# 6. Create catch.cmd launcher
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}
$LauncherPath = Join-Path $BinDir "catch.cmd"
@"
@echo off
call "$InstallDir\start.bat" %*
"@ | Set-Content -Path $LauncherPath -Encoding ASCII

# Ensure ~/.local/bin is in user PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    $env:Path += ";$BinDir"
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "   Catch installed successfully! 🎉" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host "To start Catch, open a new terminal and type:" -ForegroundColor Cyan
Write-Host "   catch" -ForegroundColor White
Write-Host ""
