# Koi aquarium (local)

Draws `koi/aquarium.svg`, an animated, high-resolution koi pond for the profile README.
It's the local copy of [Koi-Code-Aquarium](https://github.com/azizulabedinazmi/Koi-Code-Aquarium).

- **One fish per language.** Each koi is a programming language from your public repositories.
- **The real git-koi fish.** Every fish is drawn by [git-koi](https://github.com/yalongwastaken/git-koi) with only that language's GitHub colour, so its spots are that language.
- **High resolution.** Each git-koi pixel is turned into a vector square, so the pixel art stays sharp on any screen and at any zoom. Nothing is a blurry bitmap.
- **Grows with your repos.** A koi's length is proportional to how many public repositories use its language. The top language is the biggest fish, a language with half as many repos is about half the extra size, and a 1-repo language is a small fish. Add a repo in a language, and its koi grows on the next run.
- **Coding theme.** A terminal bar on top; a dark pond with a grid, faint code written in your languages, glowing circuit traces, and rising `{ }` `</>` bubbles; and a `languages.json` bar underneath that never covers the fish.
- **Your own wallpaper.** Pass any image to replace the pond background.
- **Works on GitHub.** The animation uses SVG's built-in tags (SMIL), which keep playing when GitHub shows the SVG as an `<img>`. The whole koi swims: a wave runs down each body from head to tail and the side fins paddle.

---

## Requirements

| Tool | Check | Install |
| --- | --- | --- |
| Node.js 18 or newer | `node --version` | `winget install OpenJS.NodeJS.LTS` |
| GitHub CLI, signed in | `gh auth status` | `winget install --id GitHub.cli`, then `gh auth login` |
| git-koi 1.0.2 | installed for you | `update-aquarium.ps1` downloads it into `$HOME\profile-tools\koi` and checks its SHA-256 checksum |
| Windows PowerShell 5.1 or PowerShell 7 | `$PSVersionTable.PSVersion` | Included with Windows |

The generator has no npm packages, so there's no install step.
Only public data is read.

---

## Step-by-step guide

### Step 1: Open PowerShell in the repo

```powershell
cd D:\GitHub\azizulabedinazmi
```

### Step 2: Get the latest version

```powershell
git pull
```

### Step 3: Allow local scripts (first time only)

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Step 4: Draw the aquarium

```powershell
.\.local-workflows\koi-aquarium\update-aquarium.ps1
```

This takes about a minute, because git-koi draws each fish separately. At the end it prints the file size and every language it drew:

```text
wrote koi/aquarium.svg (312 KB): Python 10, Jupyter Notebook 6, HTML 4, JavaScript 4, ...
```

### Step 5: Look at it

Open `koi\aquarium.svg` in a browser, such as Chrome or Edge. It's animated there too.

### Step 6: Commit and push

```powershell
.\.local-workflows\koi-aquarium\update-aquarium.ps1 -Push
```

`-Push` commits only `koi/aquarium.svg`, and skips the commit if the file didn't change.

### Step 7: Show it in the profile README (once)

```html
<p align="center">
  <img src="koi/aquarium.svg" width="100%" alt="Koi aquarium: one fish per programming language">
</p>
```

---

## Options

| Option | What it does | Default |
| --- | --- | --- |
| `-User <login>` | Account to draw | `azizulabedinazmi` |
| `-MaxFish <1-20>` | Most languages to show, largest first | `12` |
| `-Theme code` / `plain` | `plain` removes the grid, code, circuits and bubbles | `code` |
| `-Wallpaper <file>` | Pond background: `.jpg` `.png` `.webp` `.gif` `.svg` | none (built-in dark water) |
| `-Title <text>` | Text in the terminal bar | `<login>'s code pond` |
| `-ToolsDir <path>` | Where git-koi is kept | `$HOME\profile-tools` |
| `-Commit` / `-Push` | Commit, or commit and push, `koi/aquarium.svg` | off |

Examples:

```powershell
.\.local-workflows\koi-aquarium\update-aquarium.ps1 -Wallpaper D:\Pictures\setup.jpg -Push
```

```powershell
.\.local-workflows\koi-aquarium\update-aquarium.ps1 -Theme plain -MaxFish 8
```

You can also run the generator directly:

```powershell
node .local-workflows\koi-aquarium\koi-aquarium.mjs --help
```

---

## How it works

1. **Count languages.** The GitHub API lists your public, non-fork repositories. Each repository counts once, for its main language. The top `-MaxFish` languages become fish.
2. **Collect activity.** `git-koi collect` reads your public activity once. That sets the koi's growth and pose.
3. **Draw one koi per language.** For each language, the activity is copied with every repository set to that language, and `git-koi render` draws a koi spotted only in that colour. Pale colours, such as JavaScript yellow, get git-koi's black koi so the spots stay visible; other colours get the white koi.
4. **Vectorise.** The koi PNG is read pixel by pixel, and same-coloured pixels are merged into as few vector rectangles as possible. Only what git-koi drew is kept.
5. **Size.** Each koi's length is `84 + 176 × (its repos ÷ the top language's repos)` SVG units. With Python at 10 repos, that's 260 for Python, 190 for 6 repos, 154 for 4, and 102 for 1.
6. **Swim.** Each fish follows its own smooth loop with `animateMotion`, always head-first. The koi is cut into a chain of body segments that bend one after another, so a wave travels from a gently swaying head down to the tail fan, while the side fins paddle in turn.

The pond layout is worked out from your login and your languages, so the same data always gives the same pond.
The fish's pose can change from day to day, because git-koi's behaviour follows your most recent activity.

## About wallpapers

- The image is **embedded inside the SVG**, because GitHub won't load images linked from an SVG. The file grows by about the image's size.
- For a sharp result that still loads quickly, use roughly **2000 × 725 pixels** (the pond's shape), saved as a **JPEG or WebP under 1 MB**. Images with a different shape are cropped to fill the pond.
- The image is darkened slightly so the fish stay easy to see. Add `-Theme plain` to show it without the code decorations.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `running scripts is disabled on this system` | Do Step 3. |
| `GitHub CLI is not signed in` | Run `gh auth login`. |
| `git-koi was not found` | Run `update-aquarium.ps1`, which installs it, or pass `--git-koi <path>` to the `.mjs` directly. |
| `git-koi collect failed` | Check `gh auth status` and your internet connection, then run it again. |
| `No languages found` | The account has no public repositories with a detected language. |
| `wallpaper is ... MB` warning | Use a smaller or more compressed image. |
