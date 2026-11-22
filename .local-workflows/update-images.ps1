<#
.SYNOPSIS
    Regenerates the README's contribution snake (light + dark) and git-koi GIF on this PC.

.DESCRIPTION
    Does locally what .github/workflows/snake.yml and koi.yml do on GitHub Actions:
      1. Installs the tools into $HOME\profile-tools the first time (Platane/snk v3, git-koi v1.0.2).
      2. Writes img/github-contribution-grid-snake.svg and img/github-contribution-grid-snake-dark.svg.
      3. Writes koi/koi.gif.
      4. Optionally commits (-Commit) and pushes (-Push) the three images.

    See README.md in this folder for requirements and a step-by-step guide.

.EXAMPLE
    .\.local-workflows\update-images.ps1
    .\.local-workflows\update-images.ps1 -Body gold -Push
    .\.local-workflows\update-images.ps1 -SkipKoi -Commit
#>
[CmdletBinding()]
param(
    # GitHub account whose activity is drawn.
    [string]$User = "azizulabedinazmi",

    # Koi body colour.
    [ValidateSet("white", "black", "asagi", "tea", "gold", "platinum")]
    [string]$Body = "white",

    # Where the downloaded tools are kept (outside the repo).
    [string]$ToolsDir = (Join-Path $HOME "profile-tools"),

    [switch]$SkipSnake,
    [switch]$SkipKoi,

    # Commit the regenerated images.
    [switch]$Commit,

    # Commit and push the regenerated images (implies -Commit).
    [switch]$Push
)

# Native tools (git, gh, node, git-koi) print progress on stderr, which Windows PowerShell 5.1
# would turn into terminating errors under "Stop". Their exit codes are checked instead, and
# PowerShell cmdlets stop on error via $PSDefaultParameterValues.
$ErrorActionPreference = "Continue"
$PSDefaultParameterValues = @{ "*:ErrorAction" = "Stop" }

$SnkTag     = "v3"
$KoiVersion = "1.0.2"
$KoiTarget  = "x86_64-pc-windows-msvc"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SnakeLight = "img/github-contribution-grid-snake.svg"
$SnakeDark  = "img/github-contribution-grid-snake-dark.svg"
$KoiGif     = "koi/koi.gif"

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

function Assert-LastExit([string]$What) {
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

function Assert-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        # (SilentlyContinue overrides the Stop default above for this lookup only.)
        throw "'$Name' was not found. $Hint"
    }
}

# --- Requirements -----------------------------------------------------------
Write-Step "Checking requirements"
Assert-Command git  "Install Git: https://git-scm.com/download/win"
Assert-Command gh   "Install GitHub CLI: winget install --id GitHub.cli"
if (-not $SkipSnake) { Assert-Command node "Install Node.js 20+: winget install OpenJS.NodeJS.LTS" }

$null = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in. Run: gh auth login" }

New-Item -ItemType Directory -Force $ToolsDir | Out-Null

# --- One-time tool install ----------------------------------------------------
$SnkDir    = Join-Path $ToolsDir "snk"
$SnkScript = Join-Path $SnkDir "svg-only\dist\index.js"
if (-not $SkipSnake -and -not (Test-Path $SnkScript)) {
    Write-Step "Downloading Platane/snk $SnkTag"
    if (Test-Path $SnkDir) { Remove-Item -Recurse -Force $SnkDir }
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch $SnkTag https://github.com/Platane/snk.git $SnkDir
    Assert-LastExit "Downloading snk"
}

$KoiDir = Join-Path $ToolsDir "koi"
$KoiExe = Join-Path $KoiDir "git-koi-$KoiVersion-$KoiTarget\git-koi.exe"
if (-not $SkipKoi -and -not (Test-Path $KoiExe)) {
    Write-Step "Downloading git-koi v$KoiVersion"
    New-Item -ItemType Directory -Force $KoiDir | Out-Null
    $Zip = Join-Path $KoiDir "git-koi-$KoiVersion-$KoiTarget.zip"
    gh release download "v$KoiVersion" --repo yalongwastaken/git-koi --dir $KoiDir --clobber `
        --pattern "git-koi-$KoiVersion-$KoiTarget.zip" --pattern "git-koi-$KoiVersion-$KoiTarget.zip.sha256"
    Assert-LastExit "Downloading git-koi"

    $Expected = ((Get-Content "$Zip.sha256" -Raw).Trim() -split '\s+')[0].ToUpper()
    $Actual   = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToUpper()
    if ($Expected -ne $Actual) {
        Remove-Item -Force $Zip
        throw "git-koi checksum mismatch (expected $Expected, got $Actual). Download removed."
    }
    Expand-Archive -Path $Zip -DestinationPath $KoiDir -Force
}

Push-Location $RepoRoot
try {
    # --- Snake ----------------------------------------------------------------
    if (-not $SkipSnake) {
        Write-Step "Generating contribution snake for $User (light + dark)"
        $env:INPUT_GITHUB_USER_NAME = $User
        $env:INPUT_GITHUB_TOKEN     = (gh auth token)
        $env:INPUT_OUTPUTS          = "$SnakeLight`n$SnakeDark`?palette=github-dark"
        try {
            node $SnkScript
            Assert-LastExit "Generating the snake"
        }
        finally {
            Remove-Item Env:INPUT_GITHUB_TOKEN, Env:INPUT_GITHUB_USER_NAME, Env:INPUT_OUTPUTS -ErrorAction SilentlyContinue
        }
    }

    # --- Koi ------------------------------------------------------------------
    if (-not $SkipKoi) {
        Write-Step "Drawing git-koi for $User ($Body body)"
        $Work = Join-Path ([IO.Path]::GetTempPath()) "git-koi-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force $Work | Out-Null
        try {
            $Snapshot = Join-Path $Work "snapshot.json"
            & $KoiExe collect $User --output $Snapshot
            Assert-LastExit "Collecting koi activity"
            & $KoiExe render $Snapshot --output-dir (Join-Path $Work "out") --body $Body
            Assert-LastExit "Rendering the koi"
            New-Item -ItemType Directory -Force "koi" | Out-Null
            Copy-Item (Join-Path $Work "out\koi.gif") $KoiGif -Force
        }
        finally {
            Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
        }
    }

    # --- Summary --------------------------------------------------------------
    $Paths = @()
    if (-not $SkipSnake) { $Paths += $SnakeLight, $SnakeDark }
    if (-not $SkipKoi)   { $Paths += $KoiGif }

    Write-Step "Files written"
    foreach ($P in $Paths) {
        $Item = Get-Item $P -ErrorAction SilentlyContinue
        if (-not $Item) { throw "$P was not created." }
        # Compare with the last commit: identical output means your activity didn't change.
        $null = git diff --quiet HEAD -- $P 2>&1
        $State = if ($LASTEXITCODE -eq 0) { "unchanged since last commit" } else { "CHANGED" }
        "    {0,-46} {1,9:N0} bytes  {2}" -f $P, $Item.Length, $State | Write-Host
    }

    # --- Commit / push --------------------------------------------------------

    if ($Commit -or $Push) {
        git add -- $Paths
        Assert-LastExit "git add"
        git diff --cached --quiet -- $Paths
        if ($LASTEXITCODE -eq 0) {
            Write-Step "Images unchanged; nothing to commit"
        }
        else {
            git commit --quiet -m "Update snake and koi images" -- $Paths
            Assert-LastExit "git commit"
            Write-Step "Committed"
        }
        if ($Push) {
            git push --quiet
            Assert-LastExit "git push"
            Write-Step "Pushed"
        }
    }
    else {
        Write-Step "Done. Review with 'git status', or rerun with -Commit / -Push"
    }
}
finally {
    Pop-Location
}
