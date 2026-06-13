# geminibatch

Batch-generate fanart through the **Gemini web chat** (browser automation, *no
API*). For each source image it sends a fixed prompt, waits for Gemini to
generate the art, downloads it, and saves a **1920×620 JPEG**.

Two sources:
- **Local mode** — process every image in `./images/`.
- **System mode** (`--system <name>`) — pull a game list from the RGS-Retro
  contribute API, and for each game **missing fanart**, download its boxart,
  generate fanart, and save it to `output/<system>/`.

It works by attaching (over the Chrome DevTools Protocol) to a **real Chrome you
launch yourself**, so Google and Discord logins work normally. It's pure
JavaScript, so it also compiles to a **standalone binary** (Windows + Linux).

---

## Option A — run from source (Node ≥ 18)

```bash
npm install
```

## Option B — standalone binary (no Node needed)

Download/build `geminibatch-linux` or `geminibatch-win.exe` (see *Building*
below) and run it directly. Put a `config.json` next to it to override defaults.

---

## 1. Launch Chrome with a debug port

The script attaches to your own Chrome. Start it (keep the window open):

- **Linux:** `npm run chrome`  (or `bash start-chrome.sh`)
- **Windows:** double-click `start-chrome.bat`

A Chrome window opens on Gemini. **Log into Google** here. For system mode, also
visit the contribute site once and **log in with Discord**. The session is saved
in `./.gemini-chrome/` and reused on later runs.

## 2. Run

**Local mode** — drop images in `./images/`, then:

```bash
npm start                 # from source
./geminibatch-linux       # or the binary
```

**System mode:**

```bash
node index.js --system dos              # from source
./geminibatch-linux --system dos        # or the binary
geminibatch-win.exe --system dos        # Windows

node index.js --system dos --limit 10   # cap how many games this run
```

`--system <name>` / `-s <name>`, `--limit <n>` / `-l <n>` (0 = no limit).

Results: local mode → `output/<name>.jpg`; system mode → `output/<system>/<name>.jpg`.
Already-saved files are skipped, so runs are **resumable**.

---

## Configuration

Defaults live in [`config.js`](config.js). For the **binary**, drop a
`config.json` next to it with only the keys you want to change (deep-merged):

```json
{
  "prompt": "Inspired by the attached picture, create a fanart ...",
  "removeWatermark": true,
  "resize": { "width": 1920, "height": 620, "quality": 90, "fit": "cover" },
  "contribute": { "limit": 0, "onlyMissingFanart": true, "autoUpload": false }
}
```

Key settings: `prompt`, `removeWatermark` (strips Gemini's bottom-right mark via
`@pilio/gemini-watermark-remover` before resizing), `resize` (size/quality/`fit`),
`outputFormat` (`"jpg"`), `newChatPerImage`, `skipExisting`, `contribute.*`, and
the brittle `selectors` block (update if Gemini's UI changes). Selectors already
cover French + English.

---

## Building the standalone binaries

Requires [Bun](https://bun.sh). From this folder:

```bash
npm run build         # builds both into ./dist
npm run build:linux   # ./dist/geminibatch-linux
npm run build:win     # ./dist/geminibatch-win.exe  (cross-compiles from Linux)
```

The binary bundles the Bun runtime + all JS deps. It does **not** bundle a
browser — it attaches to the Chrome you launch in step 1.

---

## Diagnostics

```bash
npm run probe         # reports which Gemini selectors match (login + upload menu)
node probe-image.js   # inspects a generated image's download controls
```

---

## Caveats

- **Resolution** is enforced by the resize step (`fit: cover` crops, no
  distortion); Gemini treats the prompt's size as a hint.
- **Selectors are brittle** — if Gemini changes its UI, update `selectors` in
  config. The probes tell you what to change.
- **Bot checks / rate limits** — this drives the real web UI, so big batches may
  get throttled. `timeouts.betweenImages` adds a pause; if failures pile up,
  stop and re-run later (it resumes).
- **System mode upload** (`autoUpload`) is not wired yet — it generates and saves
  to `output/<system>/` for review.
```
