# Local workflows

This folder lets you regenerate the profile README's images **on your own PC**, without GitHub Actions.
Use it when Actions can't run, for example while the account is locked over billing, or when you want new images right away.

| Image in the README | File | GitHub workflow that normally makes it |
| --- | --- | --- |
| Contribution snake (light) | `img/github-contribution-grid-snake.svg` | `.github/workflows/snake.yml` |
| Contribution snake (dark) | `img/github-contribution-grid-snake-dark.svg` | `.github/workflows/snake.yml` |
| Pixel-art koi | `koi/koi.gif` | `.github/workflows/koi.yml` |

`update-images.ps1` runs the same tools those workflows use:

- [Platane/snk](https://github.com/Platane/snk) `v3` for the snake
- [git-koi](https://github.com/yalongwastaken/git-koi) `v1.0.2` for the koi

---

## Requirements

| Tool | Why | Check | Install |
| --- | --- | --- | --- |
| Windows PowerShell 5.1 or PowerShell 7 | Runs the script | `$PSVersionTable.PSVersion` | Included with Windows |
| Git | Downloads snk, commits, pushes | `git --version` | <https://git-scm.com/download/win> |
| GitHub CLI (`gh`), signed in | Reads your contributions, downloads git-koi | `gh auth status` | `winget install --id GitHub.cli`, then `gh auth login` |
| Node.js 20 or newer | Runs the snake generator | `node --version` | `winget install OpenJS.NodeJS.LTS` |

The script also needs internet access, to reach GitHub.

> **About the token:** the script uses your GitHub CLI sign-in to read your public contribution data.
> That sign-in usually has full `repo` access, which is much more than these tools need.
> The token is only placed in an environment variable while the snake generator runs and is removed straight after.
> It is never written to a file.

---

## Step-by-step guide

### Step 1: Open PowerShell in the repo

```powershell
cd D:\GitHub\azizulabedinazmi
```

### Step 2: Get the latest version of the repo

```powershell
git pull
```

### Step 3: Allow local scripts (first time only)

Windows blocks `.ps1` scripts by default. This allows scripts you created on your own PC, for your user account only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Step 4: Run the script

```powershell
.\.local-workflows\update-images.ps1
```

The first run downloads the tools into `$HOME\profile-tools`, outside the repo:

- snk is downloaded with `git clone`.
- git-koi is downloaded from its GitHub release, and its SHA-256 checksum is checked before it's unzipped. If the checksum doesn't match, the download is deleted and the script stops.

Later runs reuse those tools.

The script then writes the snake into `img/` and the koi into `koi/`. It doesn't commit or push anything unless you ask it to.

### Step 5: Check the result

At the end, the script lists every file it wrote, its size, and whether it changed since the last commit:

```text
==> Files written
    img/github-contribution-grid-snake.svg             71,599 bytes  unchanged since last commit
    img/github-contribution-grid-snake-dark.svg        71,599 bytes  unchanged since last commit
    koi/koi.gif                                       424,304 bytes  CHANGED
```

`unchanged` doesn't mean the file was skipped. The script always writes all three files.
If your contributions haven't changed since the last run, the new snake is byte-for-byte identical, so `git status` doesn't list it.

```powershell
git status
```

Open the SVG files in a browser, or `koi/koi.gif` in an image viewer, if you want to look at them.

### Step 6: Commit and push

Either run the script again with `-Push`, which commits only the three images and then pushes:

```powershell
.\.local-workflows\update-images.ps1 -Push
```

Or do it yourself:

```powershell
git add img/github-contribution-grid-snake.svg img/github-contribution-grid-snake-dark.svg koi/koi.gif
```

```powershell
git commit -m "Update snake and koi images"
```

```powershell
git push
```

---

## Options

| Option | What it does | Example |
| --- | --- | --- |
| `-User <name>` | Account to draw (default: `azizulabedinazmi`) | `-User octocat` |
| `-Body <colour>` | Koi colour: `white` (default), `black`, `asagi`, `tea`, `gold`, `platinum` | `-Body gold` |
| `-SkipSnake` | Only draw the koi | |
| `-SkipKoi` | Only draw the snake (Node.js not needed for the koi, `gh` still needed) | |
| `-Commit` | Commit the images; does nothing if they didn't change | |
| `-Push` | Commit and push | |
| `-ToolsDir <path>` | Where the tools are kept (default: `$HOME\profile-tools`) | `-ToolsDir D:\tools` |

Examples:

```powershell
.\.local-workflows\update-images.ps1 -Body asagi -Push
```

```powershell
.\.local-workflows\update-images.ps1 -SkipKoi -Commit
```

---

## Things to know

- **The images don't update on their own.** They change only when you run the script, or when the GitHub workflows can run again.
- **The koi shows yesterday.** git-koi draws the last complete day in UTC, so a koi drawn today shows yesterday's activity.
- **Pushing starts the snake workflow on GitHub.** While Actions is unavailable, that run fails within seconds. The failure is harmless, and your pushed images stay as they are.
- **Updating the tools:** delete `$HOME\profile-tools`, or one tool's folder inside it. The next run downloads the versions set at the top of the script (`$SnkTag`, `$KoiVersion`).
- **This folder is hidden on your PC but not on GitHub.** The leading dot hides it in `ls` and some file managers, but anyone viewing the repo on GitHub can still see it.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `running scripts is disabled on this system` | Do Step 3. |
| `GitHub CLI is not signed in` | Run `gh auth login`. |
| `'node' was not found` | Install Node.js, then open a new PowerShell window. |
| `git-koi checksum mismatch` | Run the script again. If it still fails, don't use that download. Check the [git-koi releases page](https://github.com/yalongwastaken/git-koi/releases). |
| `git push failed` | Run `git pull`, then push again. |
