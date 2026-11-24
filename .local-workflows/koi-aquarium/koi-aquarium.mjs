#!/usr/bin/env node
// Koi-Code-Aquarium — a high-resolution, animated koi aquarium for a GitHub profile README.
//
// Every fish is one programming language from the account's public repositories. The fish are
// the real git-koi pixel-art koi (https://github.com/yalongwastaken/git-koi), each drawn with only
// that language's colour, then converted pixel-by-pixel into vector squares so they stay sharp at
// any size. Fish size follows how many repositories use the language.
//
//   node koi-aquarium.mjs --user <login> [--out koi/aquarium.svg] [--wallpaper image.jpg]
//
// Needs Node 18+ and the git-koi command-line tool (see --help). No npm packages.

import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, delimiter } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";

const VERSION = "1.3.0";
const W = 1600; // the SVG is vector; this is only its coordinate size
const HEADER_H = 88;
const POND_H = 580;
const POND_Y0 = HEADER_H;
const POND_Y1 = HEADER_H + POND_H;
// Fish length in SVG units: a koi grows in proportion to its language's public repo count.
const MIN_FISH = 84;
const MAX_FISH = 260;

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────
const HELP = `koi-code-aquarium ${VERSION}

Usage: node koi-aquarium.mjs --user <login> [options]

Options:
  --user <login>        GitHub account to draw (default: $GITHUB_REPOSITORY_OWNER)
  --out <file>          Output SVG (default: koi/aquarium.svg)
  --max-fish <n>        Most languages to show, 1-20 (default: 12)
  --wallpaper <file>    Pond background image (.jpg .png .webp .gif .svg), embedded in the SVG
  --theme <code|plain>  "code" adds the grid, code, circuits and bubbles (default: code)
  --title <text>        Text in the terminal bar (default: "<login>'s code pond")
  --include-forks       Count forked repositories too
  --git-koi <path>      git-koi executable (default: $GIT_KOI, PATH, or ~/profile-tools/koi)
  --help, --version

Token: $GITHUB_TOKEN or $GH_TOKEN, otherwise the GitHub CLI sign-in (\`gh auth token\`).
Only public data is read. git-koi itself reads through the GitHub CLI (\`gh\`).`;

function parseArgs(argv) {
  const opts = { out: "koi/aquarium.svg", maxFish: 12, theme: "code", includeForks: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--user": opts.user = need(i, a); i++; break;
      case "--out": opts.out = need(i, a); i++; break;
      case "--max-fish": opts.maxFish = Number(need(i, a)); i++; break;
      case "--wallpaper": opts.wallpaper = need(i, a); i++; break;
      case "--theme": opts.theme = need(i, a); i++; break;
      case "--title": opts.title = need(i, a); i++; break;
      case "--git-koi": opts.gitKoi = need(i, a); i++; break;
      case "--include-forks": opts.includeForks = true; break;
      case "--help": case "-h": console.log(HELP); process.exit(0);
      case "--version": console.log(VERSION); process.exit(0);
      default: throw new Error(`Unknown option: ${a} (see --help)`);
    }
  }
  opts.user ??= process.env.GITHUB_REPOSITORY_OWNER;
  if (!["code", "plain"].includes(opts.theme)) throw new Error('--theme must be "code" or "plain"');
  if (!Number.isInteger(opts.maxFish) || opts.maxFish < 1 || opts.maxFish > 20)
    throw new Error("--max-fish must be a whole number from 1 to 20");
  if (!opts.user) throw new Error("--user is required (see --help)");
  return opts;
}

// ─── GitHub data ──────────────────────────────────────────────────────────────────────────────
function getToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("No token: set GITHUB_TOKEN, or sign in with `gh auth login`.");
  }
}

async function fetchLanguages(login, includeForks, token) {
  const query = `query($login: String!, $after: String) {
    user(login: $login) {
      repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC${includeForks ? "" : ", isFork: false"}) {
        pageInfo { hasNextPage endCursor }
        nodes { primaryLanguage { name color } }
      }
    }
  }`;
  const langs = new Map();
  let repos = 0;
  let after = null;
  do {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "koi-code-aquarium" },
      body: JSON.stringify({ query, variables: { login, after } }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (json.errors) throw new Error(`GitHub API: ${json.errors.map((e) => e.message).join("; ")}`);
    if (!json.data.user) throw new Error(`No GitHub user named ${login}`);
    const page = json.data.user.repositories;
    for (const repo of page.nodes) {
      repos++;
      const lang = repo.primaryLanguage;
      if (!lang) continue;
      const entry = langs.get(lang.name) ?? { count: 0, color: lang.color || "#8b949e" };
      entry.count++;
      langs.set(lang.name, entry);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return { repos, langs };
}

// ─── git-koi ──────────────────────────────────────────────────────────────────────────────────
async function findGitKoi(explicit) {
  const exe = process.platform === "win32" ? "git-koi.exe" : "git-koi";
  const candidates = [explicit, process.env.GIT_KOI];
  for (const dir of (process.env.PATH || "").split(delimiter)) if (dir) candidates.push(join(dir, exe));
  const tools = join(homedir(), "profile-tools", "koi");
  if (existsSync(tools)) {
    for (const d of (await readdir(tools)).sort().reverse()) candidates.push(join(tools, d, exe));
  }
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) {
    throw new Error(
      "git-koi was not found. Download it from https://github.com/yalongwastaken/git-koi/releases " +
        "and pass --git-koi <path>, set GIT_KOI, or put it on PATH.",
    );
  }
  return found;
}

function runGitKoi(gitKoi, args, token) {
  try {
    execFileSync(gitKoi, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_TOKEN: token } });
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`git-koi ${args[0]} failed: ${msg}`);
  }
}

// ─── PNG → pixel grid ─────────────────────────────────────────────────────────────────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), kind = buf.toString("ascii", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") [width, height, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (kind === "IDAT") idat.push(data);
    o += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(type) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3, stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * bpp; return [px[i], px[i + 1], px[i + 2], bpp === 4 ? px[i + 3] : 255]; } };
}

// git-koi exports each art pixel as a square block; find the block size and read one pixel per block.
function pixelArt(png) {
  let scale = 1;
  for (const s of [4, 3, 2]) {
    let ok = true;
    outer: for (let y = 0; y + s <= png.height && ok; y += s)
      for (let x = 0; x + s <= png.width; x += s) {
        const ref = png.at(x, y).join();
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) if (png.at(x + dx, y + dy).join() !== ref) { ok = false; break outer; }
      }
    if (ok) { scale = s; break; }
  }
  const pixels = [];
  for (let y = 0; y < png.height / scale; y++)
    for (let x = 0; x < png.width / scale; x++) {
      const [r, g, b, a] = png.at(x * scale, y * scale);
      if (a > 0) pixels.push({ x, y, r, g, b, a });
    }
  return pixels;
}

// Principal axis of the fish, pointing from tail to head. The tail end is the wide fan; the head
// end is the narrow snout, so the end whose last stretch is wider across is the tail.
function fishAxis(pixels) {
  const n = pixels.length;
  const cx = pixels.reduce((s, p) => s + p.x, 0) / n, cy = pixels.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pixels) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(theta), uy = Math.sin(theta);
  const along = pixels.map((p) => (p.x - cx) * ux + (p.y - cy) * uy);
  const across = pixels.map((p) => -(p.x - cx) * uy + (p.y - cy) * ux);
  let tMin = Math.min(...along), tMax = Math.max(...along);
  const spread = (lo, hi) => {
    const v = across.filter((_, i) => along[i] >= lo && along[i] <= hi);
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  };
  const end = (tMax - tMin) * 0.15;
  if (spread(tMax - end, tMax) > spread(tMin, tMin + end)) {
    // the wide end is at +t, so +t is the tail: flip to point at the head
    [ux, uy] = [-ux, -uy];
    [tMin, tMax] = [-tMax, -tMin];
  }
  return { cx, cy, ux, uy, tMin, tMax };
}

// Merge same-colour pixels into as few rectangles as possible: runs along rows, then stacked runs.
function pixelsToPaths(pixels) {
  const byColor = new Map();
  for (const p of pixels) {
    const key = `${p.r},${p.g},${p.b},${p.a}`;
    if (!byColor.has(key)) byColor.set(key, []);
    byColor.get(key).push(p);
  }
  let out = "";
  for (const [key, ps] of byColor) {
    const rows = new Map();
    for (const p of ps) { if (!rows.has(p.y)) rows.set(p.y, []); rows.get(p.y).push(p.x); }
    const runs = [];
    for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => a - b);
      let start = xs[0], prev = xs[0];
      for (const x of xs.slice(1).concat([Infinity])) {
        if (x === prev + 1) { prev = x; continue; }
        runs.push({ x: start, y, w: prev - start + 1, h: 1 });
        start = prev = x;
      }
    }
    const open = new Map(), rects = [];
    for (const r of runs) {
      const k = `${r.x}:${r.w}`, prev = open.get(k);
      if (prev && prev.y + prev.h === r.y) prev.h++;
      else { const nr = { ...r }; open.set(k, nr); rects.push(nr); }
    }
    const [r, g, b, a] = key.split(",").map(Number);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const d = rects.map((q) => `M${q.x} ${q.y}h${q.w}v${q.h}h-${q.w}z`).join("");
    out += `<path fill="${hex}"${a < 255 ? ` fill-opacity="${(a / 255).toFixed(2)}"` : ""} d="${d}"/>`;
  }
  return out;
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────
function rng(seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const f = (n) => Math.round(n * 100) / 100;
function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function closedSpline(pts) {
  const n = pts.length, p = (i) => pts[(i + n) % n];
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d} Z`;
}
const loopLength = (pts) => pts.reduce((s, a, i) => { const b = pts[(i + 1) % pts.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0) * 1.08;

// ─── koi ──────────────────────────────────────────────────────────────────────────────────────
// Draw one language's koi with git-koi, then vectorise it, facing +x and centred on (0,0).
// git-koi draws every koi of a run in the same pose, so the head direction found on a white koi
// (whose dark eyes are easy to spot) is reused for all of them, including dark-bodied ones.
async function languageKoi({ gitKoi, snapshot, work, lang, idx, token, body, refDir }) {
  const snap = structuredClone(snapshot);
  snap.repositories = snap.repositories.map((r) => ({ ...r, primary_language: lang.name }));
  snap.language_colors = { [lang.name]: lang.color.toLowerCase() };
  const dir = join(work, `fish-${idx}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "snapshot.json"), JSON.stringify(snap));
  body ??= luminance(lang.color) > 0.42 ? "black" : "white"; // pale spots read better on a dark koi
  runGitKoi(gitKoi, ["render", join(dir, "snapshot.json"), "--output-dir", join(dir, "out"), "--body", body], token);
  const pixels = pixelArt(decodePng(await readFile(join(dir, "out", "koi.png"))));
  if (pixels.length < 50) throw new Error(`git-koi drew an empty koi for ${lang.name}`);
  const axis = fishAxis(pixels);
  if (refDir && axis.ux * refDir[0] + axis.uy * refDir[1] < 0) {
    [axis.ux, axis.uy] = [-axis.ux, -axis.uy];
    [axis.tMin, axis.tMax] = [-axis.tMax, -axis.tMin];
  }
  return { ...koiRig(pixels, axis), angle: (Math.atan2(axis.uy, axis.ux) * 180) / Math.PI, center: [axis.cx, axis.cy], length: axis.tMax - axis.tMin, dir: [axis.ux, axis.uy] };
}

// Body joints, as fractions of the length from the snout. The segments between them bend one after
// another, so a wave runs from head to tail; the last segment is the tail fan.
const JOINTS = [0.3, 0.44, 0.57, 0.68, 0.79];
// Peak bend at each joint in degrees (head sway is the whole fish turning about the first joint).
const HEAD_SWAY = 4;
const BEND = [3, 4.5, 6, 8, 10];
const WAVE_LAG = 0.12; // fraction of a beat the wave takes to pass from one joint to the next

// Cut the fish into a chain of body segments plus its side fins, all in art-pixel coordinates.
function koiRig(pixels, axis) {
  const len = axis.tMax - axis.tMin;
  const pos = (p) => {
    const dx = p.x - axis.cx, dy = p.y - axis.cy;
    return { t: dx * axis.ux + dy * axis.uy, a: -dx * axis.uy + dy * axis.ux };
  };
  const u = (t) => (axis.tMax - t) / len; // 0 at the snout, 1 at the tail tip
  const at = pixels.map(pos);

  // Body outline across the fish, slice by slice. A morphological opening of that outline removes
  // bumps shorter than a fifth of the fish: those bumps are the fins sticking out of the body.
  const b0 = Math.floor(axis.tMin), nb = Math.ceil(axis.tMax) - b0 + 1;
  const hi = new Array(nb).fill(-Infinity), lo = new Array(nb).fill(Infinity);
  at.forEach(({ t, a }) => { const b = Math.round(t) - b0; hi[b] = Math.max(hi[b], a); lo[b] = Math.min(lo[b], a); });
  for (let b = 1; b < nb; b++) if (hi[b] === -Infinity) { hi[b] = hi[b - 1]; lo[b] = lo[b - 1]; }
  const w = Math.max(2, Math.round(len * 0.1));
  const slide = (arr, pick) => arr.map((_, b) => pick(...arr.slice(Math.max(0, b - w), b + w + 1)));
  const hiBody = slide(slide(hi, Math.min), Math.max);
  const loBody = slide(slide(lo, Math.max), Math.min);
  const finSide = at.map(({ t, a }) => {
    if (u(t) < 0.06 || u(t) > 0.72) return 0;
    const b = Math.round(t) - b0;
    return a > hiBody[b] + 1.5 ? 1 : a < loBody[b] - 1.5 ? -1 : 0;
  });

  // Group fin pixels into fins (8-connected); specks too small to read as a fin stay with the body.
  const key = (p) => `${p.x},${p.y}`;
  const index = new Map(pixels.map((p, i) => [key(p), i]));
  const finOf = new Array(pixels.length).fill(-1);
  const fins = [];
  pixels.forEach((p, i) => {
    if (!finSide[i] || finOf[i] !== -1) return;
    const members = [i];
    finOf[i] = fins.length;
    for (let k = 0; k < members.length; k++) {
      const q = pixels[members[k]];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = index.get(`${q.x + dx},${q.y + dy}`);
        if (j !== undefined && finOf[j] === -1 && finSide[j] === finSide[i]) { finOf[j] = fins.length; members.push(j); }
      }
    }
    fins.push(members);
  });
  const kept = [];
  fins.forEach((members, n) => {
    if (members.length < Math.max(6, len * 0.12)) { for (const i of members) finOf[i] = -1; return; }
    // the root is where the fin meets the body: its pixels nearest the body outline
    const byDepth = [...members].sort((i, j) => Math.abs(at[i].a) - Math.abs(at[j].a)).slice(0, Math.max(3, Math.ceil(members.length / 4)));
    const root = [0, 1].map((c) => byDepth.reduce((s, i) => s + (c ? pixels[i].y : pixels[i].x) + 0.5, 0) / byDepth.length);
    const rootT = byDepth.reduce((s, i) => s + at[i].t, 0) / byDepth.length;
    kept.push({ n, members, root, side: finSide[members[0]], segment: JOINTS.filter((j) => u(rootT) >= j).length });
  });
  const finIds = new Map(kept.map((fin, k) => [fin.n, k]));

  // Body segments overlap by one pixel at each joint so no seam opens while they bend.
  const segments = JOINTS.map(() => []).concat([[]]);
  pixels.forEach((p, i) => {
    if (finOf[i] !== -1 && finIds.has(finOf[i])) return;
    const v = u(at[i].t);
    segments.forEach((_, s) => {
      const from = s === 0 ? -Infinity : JOINTS[s - 1] - 1 / len, to = s === JOINTS.length ? Infinity : JOINTS[s] + 1 / len;
      if (v >= from && v < to) segments[s].push(p);
    });
  });
  const point = (j) => { const t = axis.tMax - len * j; return [axis.cx + axis.ux * t + 0.5, axis.cy + axis.uy * t + 0.5]; };
  return {
    segments: segments.map((ps) => pixelsToPaths(ps)),
    joints: JOINTS.map(point),
    fins: kept.map((fin) => ({ paths: pixelsToPaths(fin.members.map((i) => pixels[i])), root: fin.root, side: fin.side, segment: fin.segment })),
  };
}

// A smooth back-and-forth turn about (x, y), `lag` beats behind the head.
function sway(deg, [x, y], beat, lag) {
  const [cx, cy] = [f(x), f(y)];
  return `<animateTransform attributeName="transform" type="rotate" values="${-deg} ${cx} ${cy};${deg} ${cx} ${cy};${-deg} ${cx} ${cy}" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" dur="${beat}s" begin="${f(-lag * beat - 4 * beat)}s" repeatCount="indefinite"/>`;
}

function koiSvg(art, lang, length, beat) {
  const s = length / art.length;
  // Fins paddle a little faster than the body beats; the two sides take turns.
  const fins = (seg) =>
    art.fins
      .filter((fin) => fin.segment === seg)
      .map((fin) => `<g>${sway(fin.side * 16, fin.root, f(beat * 0.9), fin.side > 0 ? 0 : 0.5)}${fin.paths}</g>`)
      .join("");
  // Nest each segment inside the one ahead of it, so every joint carries everything behind it.
  // The segment ahead is drawn last, so it sits on top of the joint; fins tuck under the body.
  let chain = "";
  for (let seg = art.segments.length - 1; seg >= 1; seg--) {
    chain = `<g>${sway(BEND[seg - 1], art.joints[seg - 1], beat, seg * WAVE_LAG)}${chain}${fins(seg)}${art.segments[seg]}</g>`;
  }
  return `<ellipse cx="${f(length * 0.06)}" cy="0" rx="${f(length * 0.52)}" ry="${f(length * 0.2)}" fill="${lang.color}" opacity="0.28" filter="url(#glow)"/>
  <ellipse cx="${f(length * 0.1)}" cy="${f(length * 0.12)}" rx="${f(length * 0.42)}" ry="${f(length * 0.13)}" fill="#000" opacity="0.32" filter="url(#soft)"/>
  <g transform="scale(${f(s)}) rotate(${f(-art.angle)}) translate(${f(-art.center[0])} ${f(-art.center[1])})" shape-rendering="crispEdges">
    <g>${sway(HEAD_SWAY, art.joints[0], beat, 0.5)}${chain}${fins(0)}${art.segments[0]}</g>
  </g>`;
}

// ─── pond decoration ──────────────────────────────────────────────────────────────────────────
const SNIPPETS = {
  Python: ["def swim(koi): return koi.glide()", "import pond as np", "koi = [Koi(l) for l in langs]"],
  "Jupyter Notebook": ["In [12]: pond.describe()", "Out[12]: <Koi swimming=True>"],
  HTML: ['<pond class="koi"></pond>', "<!-- feed the fish -->"],
  JavaScript: ["const koi = await pond.spawn();", "koi.on('swim', () => ripple());"],
  PHP: ["<?php echo $koi->swim(); ?>", "$pond = new Pond($langs);"],
  TypeScript: ["type Koi = { lang: string; size: number };", "export const pond: Koi[] = [];"],
  C: ["#include <pond.h>", "while (alive) swim(&koi);"],
  Java: ["public class Koi extends Fish {}", "pond.stream().forEach(Koi::swim);"],
  "C++": ["std::vector<Koi> pond;", "for (auto& k : pond) k.swim();"],
  PLSQL: ["SELECT name FROM koi WHERE alive = 1;", "BEGIN feed_koi; END;"],
  CSS: [".koi { animation: swim 9s infinite; }"],
  PowerShell: ["Get-Koi | Where-Object Alive", "Invoke-Swim -Pond $pond"],
  Go: ["go koi.Swim(pond)", "func (k *Koi) Glide() {}"],
  Rust: ["impl Swim for Koi {}", "let pond: Vec<Koi> = vec![];"],
  Shell: ["while true; do swim; done"],
};
const GENERIC = ['git commit -m "feed the koi"', "for (;;) { swim(); }", "0x4B 0x4F 0x49", "// TODO: more koi", "ping pond.local"];

function decorations(r, langNames) {
  const lines = langNames.flatMap((n) => SNIPPETS[n] ?? [`// ${n} koi swims here`]).concat(GENERIC);
  let code = "";
  for (let k = 0; k < 30; k++) {
    code += `<text x="${f(30 + r() * (W - 360))}" y="${f(POND_Y0 + 30 + r() * (POND_H - 50))}" opacity="${f(0.06 + r() * 0.07)}">${esc(lines[k % lines.length])}</text>`;
  }
  let traces = "";
  for (let k = 0; k < 9; k++) {
    const fromLeft = k % 2 === 0;
    let x = fromLeft ? 0 : W, y = f(POND_Y0 + 40 + r() * (POND_H - 80));
    let d = `M${x},${y}`;
    for (let s = 0; s < 3; s++) {
      x = fromLeft ? f(x + 80 + r() * 170) : f(x - 80 - r() * 170);
      y = f(Math.min(POND_Y1 - 30, Math.max(POND_Y0 + 30, y + (r() - 0.5) * 140)));
      d += ` H${x} V${y}`;
    }
    const dur = f(5 + r() * 6);
    traces += `<path d="${d}" class="trace"/><circle cx="${x}" cy="${y}" r="3.5" class="node"/>`;
    traces += `<path d="${d}" class="pulse" pathLength="1000" stroke-dasharray="70 930"><animate attributeName="stroke-dashoffset" values="1000;0" dur="${dur}s" begin="-${f(r() * dur)}s" repeatCount="indefinite"/></path>`;
  }
  let bubbles = "";
  const glyphs = ["{ }", "</>", "0", "1", ";", "()", "=>", "#", "[ ]", "&&"];
  for (let k = 0; k < 22; k++) {
    const x = f(40 + r() * (W - 80)), dur = f(14 + r() * 16), size = Math.round(12 + r() * 10), off = f(r() * dur);
    bubbles += `<text x="${x}" y="${POND_Y1 + 20}" font-size="${size}" opacity="0"><animateTransform attributeName="transform" type="translate" values="0 0;${f((r() - 0.5) * 60)} -${POND_H + 40}" dur="${dur}s" begin="-${off}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.35;0.35;0" keyTimes="0;0.15;0.8;1" dur="${dur}s" begin="-${off}s" repeatCount="indefinite"/>${esc(glyphs[k % glyphs.length])}</text>`;
  }
  return { code, traces, bubbles };
}

async function wallpaperImage(file) {
  const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
  const type = types[extname(file).toLowerCase()];
  if (!type) throw new Error(`--wallpaper must be one of ${Object.keys(types).join(" ")}`);
  const data = await readFile(file);
  if (data.length > 3 * 1024 * 1024) console.warn(`warning: wallpaper is ${(data.length / 1048576).toFixed(1)} MB; GitHub may not display a very large SVG`);
  return `<image href="data:${type};base64,${data.toString("base64")}" x="0" y="${POND_Y0}" width="${W}" height="${POND_H}" preserveAspectRatio="xMidYMid slice"/>
<rect y="${POND_Y0}" width="${W}" height="${POND_H}" fill="#020617" opacity="0.42"/>`;
}

// ─── SVG ──────────────────────────────────────────────────────────────────────────────────────
async function buildSvg({ user, title, theme, wallpaperFile, repos, entries, arts }) {
  const r = rng(`${user}:${entries.map((e) => e.name).join(",")}`);
  const max = Math.max(...entries.map((e) => e.count));
  const n = entries.length;

  // legend bar under the pond: 4 chips per row
  const perRow = 4, chipW = (W - 80) / perRow, rowH = 36;
  const legendRows = Math.ceil(n / perRow);
  const LEGEND_Y0 = POND_Y1;
  const H = LEGEND_Y0 + 64 + legendRows * rowH + 18;

  // one closed swim loop per fish, spread on a jittered grid inside the pond
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 2.4)));
  const rows = Math.ceil(n / cols);
  const box = { x0: 130, x1: W - 130, y0: POND_Y0 + 70, y1: POND_Y1 - 60 };
  const cw = (box.x1 - box.x0) / cols, ch = (box.y1 - box.y0) / rows;
  const fish = entries.map((e, i) => {
    const cx = box.x0 + cw * ((i % cols) + 0.5) + (r() - 0.5) * cw * 0.3;
    const cy = box.y0 + ch * (Math.floor(i / cols) + 0.5) + (r() - 0.5) * ch * 0.3;
    const rx = cw * (0.62 + r() * 0.25), ry = ch * (0.5 + r() * 0.2);
    const start = r() * Math.PI * 2;
    let pts = [];
    for (let p = 0; p < 7; p++) {
      const a = start + (p / 7) * Math.PI * 2 + (r() - 0.5) * 0.35, m = 0.78 + r() * 0.35;
      pts.push([Math.min(box.x1, Math.max(box.x0, cx + Math.cos(a) * rx * m)), Math.min(box.y1, Math.max(box.y0, cy + Math.sin(a) * ry * m))]);
    }
    if (r() < 0.5) pts = pts.reverse();
    // grows in proportion to the repo count: the top language is 260 long, a 1-repo language ~100
    const length = MIN_FISH + (MAX_FISH - MIN_FISH) * (e.count / max);
    const dur = f(loopLength(pts) / (32 + r() * 24));
    return { e, art: arts[i], length, path: closedSpline(pts), dur, begin: f(r() * dur), beat: f(0.8 + r() * 0.5) };
  });

  const deco = theme === "code" ? decorations(r, entries.map((e) => e.name)) : null;
  const bg = wallpaperFile
    ? await wallpaperImage(wallpaperFile)
    : `<rect y="${POND_Y0}" width="${W}" height="${POND_H}" fill="url(#deep)"/><rect y="${POND_Y0}" width="${W}" height="${POND_H}" fill="url(#surface)"/>`;

  const school = [...fish]
    .sort((a, b) => a.length - b.length) // small fish swim deeper
    .map((fi) => `<g>
  <animateMotion path="${fi.path}" dur="${fi.dur}s" begin="-${fi.begin}s" rotate="auto" repeatCount="indefinite"/>
  ${koiSvg(fi.art, fi.e, fi.length, fi.beat)}
</g>`)
    .join("\n");

  const rays = [140, 470, 820, 1180, 1450]
    .map((x, k) => `<polygon points="${x},${POND_Y0} ${x + 90},${POND_Y0} ${x + 300},${POND_Y1} ${x + 120},${POND_Y1}" fill="#7dd3fc" opacity="0.025"><animate attributeName="opacity" values="0.015;0.05;0.015" dur="${9 + k * 2}s" repeatCount="indefinite"/></polygon>`)
    .join("");

  const header = `<g class="mono">
  <rect width="${W}" height="${HEADER_H}" fill="#020617"/>
  <line x1="0" y1="${HEADER_H - 0.5}" x2="${W}" y2="${HEADER_H - 0.5}" class="rule"/>
  <circle cx="34" cy="30" r="7" fill="#ff5f57"/><circle cx="56" cy="30" r="7" fill="#febc2e"/><circle cx="78" cy="30" r="7" fill="#28c840"/>
  <text x="${W / 2}" y="35" font-size="15" class="dim" text-anchor="middle">${esc(title)}</text>
  <text x="${W - 26}" y="35" font-size="15" class="dim" text-anchor="end">Koi-Code-Aquarium</text>
  <text x="26" y="70" font-size="18"><tspan class="prompt">${esc(user)}@github</tspan><tspan class="dim">:</tspan><tspan class="path">~/pond</tspan><tspan class="dim">$ </tspan><tspan class="cmd">./swim --langs ${n} --repos ${repos} </tspan><tspan class="cmd">█<animate attributeName="fill-opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></tspan></text>
</g>`;

  let chips = "";
  entries.forEach((e, idx) => {
    const x = 40 + (idx % perRow) * chipW, y = LEGEND_Y0 + 82 + Math.floor(idx / perRow) * rowH;
    const comma = idx < n - 1 ? "," : "";
    chips += `<circle cx="${f(x + 8)}" cy="${y - 6}" r="7" fill="${e.color}"/><text x="${f(x + 24)}" y="${y}"><tspan class="str">"${esc(e.name)}"</tspan><tspan class="pun">: </tspan><tspan class="num">${e.count}</tspan><tspan class="pun">${comma}</tspan></text>`;
  });
  const legend = `<g class="mono" font-size="17">
  <rect y="${LEGEND_Y0}" width="${W}" height="${H - LEGEND_Y0}" fill="#020617"/>
  <line x1="0" y1="${LEGEND_Y0 + 0.5}" x2="${W}" y2="${LEGEND_Y0 + 0.5}" class="rule"/>
  <text x="40" y="${LEGEND_Y0 + 40}" font-size="15"><tspan class="dim">languages.json</tspan><tspan class="pun">  { </tspan><tspan class="dim">language: public repos · one koi each</tspan><tspan class="pun"> }</tspan></text>
  ${chips}
</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(`${user}'s koi aquarium: ${entries.map((e) => `${e.name} (${e.count})`).join(", ")}`)}">
<title>${esc(title)}</title>
<!-- koi-code-aquarium ${VERSION} · one git-koi per language · https://github.com/azizulabedinazmi/Koi-Code-Aquarium -->
<defs>
  <linearGradient id="deep" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0b1d33"/><stop offset="0.55" stop-color="#06111f"/><stop offset="1" stop-color="#020617"/>
  </linearGradient>
  <radialGradient id="surface" cx="0.5" cy="-0.15" r="0.9">
    <stop offset="0" stop-color="#22d3ee" stop-opacity="0.16"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
    <stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/>
  </radialGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M40 0H0V40" fill="none" stroke="#38bdf8" stroke-opacity="0.07" stroke-width="1"/>
  </pattern>
  <clipPath id="frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
  <clipPath id="pond"><rect y="${POND_Y0}" width="${W}" height="${POND_H}"/></clipPath>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
  <style>
    .mono { font-family: ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace; }
    .code text { fill: #7dd3fc; font-size: 14px; }
    .bubbles text { fill: #67e8f9; }
    .trace { fill: none; stroke: #22d3ee; stroke-opacity: 0.13; stroke-width: 1.5; }
    .pulse { fill: none; stroke: #67e8f9; stroke-opacity: 0.55; stroke-width: 2; stroke-linecap: round; }
    .node { fill: #22d3ee; fill-opacity: 0.35; }
    .rule { stroke: #38bdf8; stroke-opacity: 0.25; }
    .dim { fill: #64748b; } .prompt { fill: #4ade80; } .path { fill: #60a5fa; } .cmd { fill: #e2e8f0; }
    .str { fill: #a5f3fc; } .num { fill: #fbbf24; } .pun { fill: #94a3b8; }
  </style>
</defs>
<g clip-path="url(#frame)">
${header}
<g clip-path="url(#pond)">
${bg}
${deco ? `<rect y="${POND_Y0}" width="${W}" height="${POND_H}" fill="url(#grid)"/>
<g class="mono code">${deco.code}</g>
<g>${deco.traces}</g>` : ""}
${rays}
${school}
${deco ? `<g class="mono bubbles">${deco.bubbles}</g>` : ""}
<rect y="${POND_Y0}" width="${W}" height="${POND_H}" fill="url(#vignette)"/>
</g>
${legend}
</g>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="none" stroke="#38bdf8" stroke-opacity="0.35" stroke-width="2"/>
</svg>
`;
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = getToken();
  const gitKoi = await findGitKoi(opts.gitKoi);
  const { repos, langs } = await fetchLanguages(opts.user, opts.includeForks, token);
  const entries = [...langs.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, opts.maxFish);
  if (!entries.length) throw new Error("No languages found in the public repositories.");

  const work = await mkdtemp(join(tmpdir(), "koi-aquarium-"));
  try {
    const snapPath = join(work, "snapshot.json");
    runGitKoi(gitKoi, ["collect", opts.user, "--output", snapPath], token);
    const snapshot = JSON.parse(await readFile(snapPath, "utf8"));
    const ref = await languageKoi({ gitKoi, snapshot, work, lang: { name: "Reference", color: "#ff00ff" }, idx: "ref", token, body: "white" });
    const arts = [];
    for (const [idx, lang] of entries.entries()) arts.push(await languageKoi({ gitKoi, snapshot, work, lang, idx, token, refDir: ref.dir }));
    const svg = await buildSvg({
      user: opts.user,
      title: opts.title ?? `${opts.user}'s code pond`,
      theme: opts.theme,
      wallpaperFile: opts.wallpaper,
      repos,
      entries,
      arts,
    });
    const out = resolve(opts.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, svg);
    console.log(`wrote ${opts.out} (${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB): ${entries.map((e) => `${e.name} ${e.count}`).join(", ")}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`koi-code-aquarium: ${err.message}`);
  process.exit(1);
});
