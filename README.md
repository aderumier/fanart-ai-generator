# geminibatch

Batch-generate fanart through the **Gemini web chat** (browser automation, *no
API*). For each source image it sends a fixed prompt, waits for Gemini to
generate the art, downloads it, and saves a **1920×620 JPEG**.

Two sources:
- **Local mode** — process every image in `./images/`.
- **System mode** (`--system <name>`) — pull a game list from the RGS-Retro
  contribute API, and for each game **missing fanart**, download its boxart
  (or another field via `--field`), generate fanart, save it to `output/<system>/`,
  and (by default) upload it back. Optionally filter by rompath with `--directory`.

It works by attaching (over the Chrome DevTools Protocol) to a **real Chrome you
launch yourself**, so Google and Discord logins work normally.

Runs on **Node.js ≥ 18** (Windows, Linux, macOS).

---

## Requirements

You need two things on your machine:

| Dependency | Why | Version |
| --- | --- | --- |
| **Node.js** (with `npm`) | runs the script | **≥ 18** (LTS recommended) |
| **Google Chrome** | the script attaches to it over the DevTools Protocol; logins happen in this real browser | any recent stable |

> The Node packages it uses — `playwright-core`, `jimp`,
> `@pilio/gemini-watermark-remover`, `chromium-bidi` — are pure JavaScript and
> installed by `npm install`. There is **no compiler/native build step** and
> **no Playwright browser download** (it drives *your* Chrome), so nothing else
> is required.

### Install Node.js

- **Any OS:** download the LTS installer from [nodejs.org](https://nodejs.org).
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt install nodejs npm        # may be older than 18; check `node -v`
  # newer (NodeSource):
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
  ```
- **Linux (Fedora):** `sudo dnf install nodejs`
- **macOS (Homebrew):** `brew install node`
- **Windows:** `winget install OpenJS.NodeJS.LTS` (or `choco install nodejs-lts`)

Check it: `node -v` should print `v18` or higher.

### Install Google Chrome

- **Windows / macOS:** [google.com/chrome](https://www.google.com/chrome/)
  (or `winget install Google.Chrome` / `brew install --cask google-chrome`).
- **Linux (Debian/Ubuntu):**
  ```bash
  wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt install ./google-chrome-stable_current_amd64.deb
  ```
- **Linux (Fedora):** `sudo dnf install google-chrome-stable` (Google repo).

If your Chrome binary isn't named `google-chrome` on the `PATH` (e.g. Chromium,
or a custom path), set `chromeBinary` in [`config.js`](config.js) accordingly.

---

## Setup

With the requirements above installed, fetch the Node packages once:

```bash
npm install
```

### Or grab a prebuilt package

Each tagged release ships ready-to-run **Linux** and **Windows** zips on the
[Releases page](https://github.com/aderumier/fanart-ai-generator/releases)
(`fanart-ai-generator-linux.zip` / `-windows.zip`). They include the app and its
`node_modules`, so just unzip and skip `npm install` — you still need **Node.js
≥ 18** installed and a local Chrome. Then jump to *Launch Chrome* below.

## 1. Launch Chrome with a debug port

The script attaches to your own Chrome. Start it (keep the window open):

- **Linux/macOS:** `npm run chrome`  (or `bash start-chrome.sh`)
- **Windows:** double-click `start-chrome.bat`

A Chrome window opens on Gemini. **Log into Google** here. For system mode, also
visit the contribute site once and **log in with Discord**. The session is saved
in `./.gemini-chrome/` and reused on later runs.

Leave this window open while you run the app. **Stopping the launcher (Ctrl+C, or
closing it) now closes that Chrome too** — only the instance using this project's
`.gemini-chrome` profile, so your everyday Chrome windows are left alone.

> ⚠️ **Set the Gemini interface language to English.** The script finds the
> upload/menu buttons by their labels, which are matched in English (French also
> works). With another UI language (e.g. Danish) those buttons won't be found and
> uploads will fail. Change it in your Google Account → *Data & privacy* →
> *Language*, or at <https://myaccount.google.com/language>, then reload Gemini.

## 2. Run

**Local mode** — drop images in `./images/`, then:

```bash
npm start                 # Linux/macOS
run.bat                   # Windows
```

**System mode:**

```bash
# Linux/macOS
node index.js --system dos
node index.js --system dos --limit 10
node index.js --system dos --directory /            # only games in the root
node index.js --system dos --directory /subdir      # only games in subdir
node index.js --system dos --field image            # source from the "image" field

# Windows
run.bat --system dos
run.bat --system dos --limit 10
run.bat --system dos --directory /subdir
run.bat --system dos --field image
```

Flags: `--system <name>` / `-s <name>`, `--limit <n>` / `-l <n>` (0 = no limit),
`--directory <dir>` / `-d <dir>`, `--field <name>` / `-f <name>`.

`--field` chooses which API field is used as the source image instead of the
default boxart (e.g. `image`, `screenshot`). It still falls back to boxart/image
when a game lacks that field. The per-game log shows the field used, e.g.
`[name] (image)`.

`--directory` filters games by the rompath directory encoded in their game id:
`/` selects only games in the system root, `/subdir` only games whose rom is in
`subdir` (exact directory, not recursive). Omit it (or set `contribute.directory`
to `""`) to process every directory.

Results: local mode → `output/<name>.jpg`; system mode → `output/<system>/<name>.jpg`.
Already-saved files are skipped, so runs are **resumable**.

---

## Configuration

Defaults live in [`config.js`](config.js). You can also drop a `config.json` in
the project folder with only the keys you want to change (deep-merged over the
defaults — handy for editing settings without touching the source):

```json
{
  "prompt": "Inspired by the attached picture, create a fanart ...",
  "removeWatermark": true,
  "resize": { "width": 1920, "height": 620, "quality": 90, "fit": "cover" },
  "contribute": { "limit": 0, "onlyMissingFanart": true, "autoUpload": false }
}
```

Key settings: `prompt`, `removeWatermark` (strips Gemini's bottom-right mark via
`@pilio/gemini-watermark-remover` before resizing), `cropWatermarkIfNotRemoved`
(when that detector can't remove the mark, crop off the right strip that contains
it instead of leaving it in — on by default), `resize` (size/quality/`fit`),
`outputFormat` (`"jpg"`), `newChatPerImage`, `skipExisting`, `rememberRefusals`
(remember refused games per system and skip them next run), `contribute.*`, and
the brittle `selectors` block (update if Gemini's UI changes). Selectors already
cover French + English.

---

## Quota limit & refusals

When Gemini answers with text instead of an image, the run reacts based on two
phrase lists in [`config.js`](config.js):

- **`quotaMessages`** — the daily image-generation quota is exhausted (e.g.
  *"I can't create more images for you today"*). The whole run **stops**
  immediately; there's no point retrying the rest today. Re-run tomorrow — it
  resumes (already-saved files are skipped).
- **`retryMessages`** — Gemini hit a *transient* error and asked to try again
  (e.g. *"I encountered an error doing what you asked…"*). The same image is
  **re-generated**, up to `generationRetries` times (default 2), before giving up.
- **`skipMessages`** — Gemini refused *this* image but the run should continue
  (e.g. *"I can create images of people…"*, *"…I can't depict some public
  figures…"*). That game is **skipped right away** (no waiting out the timeout)
  and the next one starts.

Matching is case-insensitive, folds typographic apostrophes (so `can't` matches
`can't`), and only looks at text Gemini added in reply to the current prompt.

In **system mode**, a refused game is remembered in `output/<system>/_refused.json`
(when `rememberRefusals` is on, the default) and **skipped automatically on future
runs** — these refusals are permanent (e.g. a real person on the boxart), so there's
no point spending a prompt on them again. Delete that file (or an entry) to retry.

If a run gets stuck waiting and then logs a refusal you don't recognise, copy
the exact wording from the timeout dump:

```
(no image) Gemini's reply text was:
----
…the text Gemini actually sent…
----
```

and add a distinctive substring of it to `quotaMessages` (to stop) or
`skipMessages` (to skip) — in `config.js`, or via a `config.json` override:

```json
{
  "skipMessages": ["depict some public figures", "I can create images of people"]
}
```

> Note: a `config.json` array **replaces** the default list rather than
> appending — include the defaults you still want when overriding.

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
  stop and re-run later (it resumes). Flaky attach/download steps are retried
  automatically (without re-generating, so they cost no quota).
- **System mode upload** — with `contribute.autoUpload` on (the default) each
  generated fanart is uploaded back to the game; set it to `false` to only save
  to `output/<system>/` for manual review.
- **Stopping a run** — Ctrl+C stops the app and exits Node cleanly (it leaves
  *your* Chrome running; use the launcher's Ctrl+C to close Chrome).
```
