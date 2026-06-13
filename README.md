# geminibatch

Batch-process a folder of images through the **Gemini web chat** (browser
automation with Playwright — *no API*). For each image it sends the same prompt,
waits for Gemini to generate fanart, downloads it, and resizes to 1920×620.

## How it works

It drives a real Chrome window with Playwright using a **persistent profile**,
so you log into Google **once** and the session is reused on every later run.
Local files are read straight from `./images/` — something a browser extension
cannot do, which is why this is a script and not an extension.

## Setup

```bash
npm install            # installs Playwright + sharp, downloads Chromium
```

## First run — log in

```bash
npm run login
```

A Chrome window opens on Gemini. Sign into your Google account. Once the chat
input appears, the session is saved to `./.gemini-profile/` and the script
exits. You won't need to log in again unless Google expires the session.

## Run the batch

1. Drop your source images into `./images/`
2. Run:

```bash
npm start
```

Results land in `./output/` as `<name>_fanart.png`. Already-processed images are
skipped, so you can stop and resume.

## Configuration

Everything is in [`config.js`](config.js): the prompt, input/output folders,
target resolution and crop mode (`resize.fit`), timeouts, and the **CSS
selectors**. If Gemini changes its UI and the script can't find the prompt box,
upload button, or send button, update the `selectors` block.

## Caveats

- **Resolution:** Gemini treats "1920×620" as a hint, not a rule. The `sharp`
  resize step (`resize.enabled`) forces the exact final size; with `fit: cover`
  it crops rather than distorts. Set `enabled: false` to keep raw output.
- **Selectors are brittle.** Google can change the page layout at any time; if a
  run fails to find an element, tweak `config.selectors`.
- **Bot checks / rate limits.** This drives the real web UI, so Google may
  throttle or challenge heavy use. `timeouts.betweenImages` adds a pause between
  images to look less robotic. Keep batches reasonable.
- Run it on a machine where you can watch the window (`headless: false`).

## Project layout

```
config.js     # all settings (prompt, paths, selectors, resolution)
index.js      # the automation loop
images/       # put your input images here
output/       # generated fanart lands here
.gemini-profile/  # saved Chrome login session (created on first login)
```
