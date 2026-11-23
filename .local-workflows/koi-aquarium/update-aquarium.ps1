<#
.SYNOPSIS
    Regenerates koi/aquarium.svg: one git-koi per programming language in your public repos,
    converted to vector so it stays sharp at any size. Takes about a minute.

.EXAMPLE
    .\.local-workflows\koi-aquarium\update-aquarium.ps1
    .\.local-workflows\koi-aquarium\update-aquarium.ps1 -Wallpaper D:\Pictures\desk.jpg -Push
    .\.local-workflows\koi-aquarium\update-aquarium.ps1 -Theme plain -MaxFish 8
#>
[CmdletBinding()]
param(
    [string]$User = "azizulabedinazmi",
    [ValidateRange(1, 20)][int]$MaxFish = 12,
    [ValidateSet("code", "plain")][string]$Theme = "code",
    # Optional background image (.jpg .png .webp .gif .svg). Keep it under ~1 MB.
    [string]$Wallpaper,
    [string]$Title,
    # Where git-koi is kept (shared with ..\update-images.ps1).
    [string]$ToolsDir = (Join-Path $HOME "profile-tools"),
    [switch]$Commit,
    [switch]$Push
)

$KoiVersion = "1.0.2"
$KoiTarget  = "x86_64-pc-windows-msvc"

$ErrorActionPreference = "Continue"
$PSDefaultParameterValues = @{ "*:ErrorAction" = "Stop" }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Script   = Join-Path $PSScriptRoot "koi-aquarium.mjs"
$Out      = "koi/aquarium.svg"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required: winget install OpenJS.NodeJS.LTS" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue))   { throw "GitHub CLI is required: winget install --id GitHub.cli" }
$null = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in. Run: gh auth login" }

# git-koi draws the fish. Install it once (same location and checksum check as update-images.ps1).
$KoiDir = Join-Path $ToolsDir "koi"
$KoiExe = Join-Path $KoiDir "git-koi-$KoiVersion-$KoiTarget\git-koi.exe"
if (-not (Test-Path $KoiExe)) {
    Write-Host "==> Downloading git-koi v$KoiVersion" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force $KoiDir | Out-Null
    $Zip = Join-Path $KoiDir "git-koi-$KoiVersion-$KoiTarget.zip"
    gh release download "v$KoiVersion" --repo yalongwastaken/git-koi --dir $KoiDir --clobber `
        --pattern "git-koi-$KoiVersion-$KoiTarget.zip" --pattern "git-koi-$KoiVersion-$KoiTarget.zip.sha256"
    if ($LASTEXITCODE -ne 0) { throw "Downloading git-koi failed." }
    $Expected = ((Get-Content "$Zip.sha256" -Raw).Trim() -split '\s+')[0].ToUpper()
    $Actual   = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToUpper()
    if ($Expected -ne $Actual) { Remove-Item -Force $Zip; throw "git-koi checksum mismatch; download removed." }
    Expand-Archive -Path $Zip -DestinationPath $KoiDir -Force
}

$NodeArgs = @($Script, "--user", $User, "--out", $Out, "--max-fish", $MaxFish, "--theme", $Theme, "--git-koi", $KoiExe)
if ($Wallpaper) { $NodeArgs += @("--wallpaper", (Resolve-Path $Wallpaper).Path) }
if ($Title)     { $NodeArgs += @("--title", $Title) }

Push-Location $RepoRoot
try {
    Write-Host "==> Drawing the koi aquarium for $User" -ForegroundColor Cyan
    node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "Generating the aquarium failed (exit code $LASTEXITCODE)." }

    if ($Commit -or $Push) {
        git add -- $Out
        git diff --cached --quiet -- $Out
        if ($LASTEXITCODE -eq 0) { Write-Host "==> Aquarium unchanged; nothing to commit" -ForegroundColor Cyan }
        else {
            git commit --quiet -m "Update koi aquarium" -- $Out
            if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
            Write-Host "==> Committed" -ForegroundColor Cyan
        }
        if ($Push) {
            git push --quiet
            if ($LASTEXITCODE -ne 0) { throw "git push failed." }
            Write-Host "==> Pushed" -ForegroundColor Cyan
        }
    }
}
finally {
    Pop-Location
}
