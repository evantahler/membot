#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

$Repo = "evantahler/membot"
$InstallDir = if ($env:MEMBOT_INSTALL_DIR) { $env:MEMBOT_INSTALL_DIR } else { "$env:LOCALAPPDATA\membot" }

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

$Artifact = "membot-windows-${Arch}.exe"

Write-Host "Fetching latest release..."
try {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "membot-installer" }
    $Tag = $Release.tag_name
}
catch {
    Write-Error "Could not determine latest release: $_"
    exit 1
}

if (-not $Tag) {
    Write-Error "Could not determine latest release tag"
    exit 1
}

$Url = "https://github.com/$Repo/releases/download/$Tag/$Artifact"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$OutFile = Join-Path $InstallDir "membot.exe"

Write-Host "Downloading membot $Tag (windows/$Arch)..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}
catch {
    Write-Error "Download failed: $_"
    exit 1
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host "Adding $InstallDir to user PATH..."
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Restart your terminal for PATH changes to take effect."
}

Write-Host "membot $Tag installed to $OutFile"
