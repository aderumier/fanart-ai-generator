import { chromium } from "playwright-core";
import Jimp from "jimp";
import {
  removeWatermarkFromImageData,
  detectWatermarkConfig,
  calculateWatermarkPosition,
} from "@pilio/gemini-watermark-remover";
import { config } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// Thrown when Gemini reports the daily image quota is exhausted. The `.quota`
// flag lets the run loops recognise it across module boundaries and stop.
class QuotaReachedError extends Error {
  constructor(message = "Daily image quota reached") {
    super(message);
    this.name = "QuotaReachedError";
    this.quota = true;
  }
}

// Normalise for matching: lowercase + fold all the apostrophe-like glyphs Gemini
// may render (curly ' ‘, modifier ʼ, prime ′, backtick) down to a straight ',
// so a pattern with "can't" matches a rendered "can't". Also collapse whitespace.
const normalizeText = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[‘’ʼ′`´]/g, "'")
    .replace(/\s+/g, " ");

// The latest model response text (scoped to the main chat area, last chunk).
async function responseText(page) {
  return page
    .evaluate(() => (document.querySelector("main") || document.body).innerText || "")
    .catch(() => "");
}

// Text added since `baseline` was captured. Gemini's /app frequently reloads the
// PREVIOUS conversation, so the page can still show an earlier game's response;
// we only ever want to act on what appeared after the current prompt was sent.
function newSinceBaseline(full, baseline) {
  const nf = normalizeText(full);
  const nb = normalizeText(baseline || "");
  return nf.startsWith(nb) ? nf.slice(nb.length) : nf;
}

// First configured phrase in `patterns` that appears in the NEW response text
// (anything added since `baseline`), or null.
async function matchResponse(page, patterns, baseline) {
  if (!patterns || patterns.length === 0) return null;
  const text = newSinceBaseline(await responseText(page), baseline);
  return patterns.find((p) => text.includes(normalizeText(p))) || null;
}

// --system <name> (or -s <name>, --system=<name>, or a bare first argument).
// When set, pull games from the contribute site instead of the local folder.
function parseSystemArg(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--system" || args[i] === "-s") && args[i + 1]) return args[i + 1];
    if (args[i].startsWith("--system=")) return args[i].slice("--system=".length);
  }
  // Bare positional, but skip a value that belongs to another flag (e.g. --limit 10).
  const valueFlags = new Set([
    "--system", "-s", "--limit", "-l", "--directory", "-d", "--field", "-f",
    "--startletter", "--port", "-p", "--ports",
  ]);
  const positional = args.find((a, i) => !a.startsWith("-") && !valueFlags.has(args[i - 1]));
  return positional || null;
}
const SYSTEM = parseSystemArg(process.argv.slice(2));

// --limit <n> (or -l <n>, --limit=<n>): cap how many games to process this run.
// Overrides config.contribute.limit. 0 = no limit.
function parseLimitArg(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--limit" || args[i] === "-l") && args[i + 1] !== undefined)
      return Number(args[i + 1]);
    if (args[i].startsWith("--limit=")) return Number(args[i].slice("--limit=".length));
  }
  return null;
}
const LIMIT = parseLimitArg(process.argv.slice(2));
if (LIMIT !== null && Number.isFinite(LIMIT)) config.contribute.limit = LIMIT;

// --directory <d> (or -d <d>, --directory=<d>): system mode only. Filter games by
// the rompath directory encoded in their game id. "/" = games in the root only,
// "/subdir" = games in that subdirectory. Overrides config.contribute.directory.
function parseDirectoryArg(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--directory" || args[i] === "-d") && args[i + 1] !== undefined)
      return args[i + 1];
    if (args[i].startsWith("--directory=")) return args[i].slice("--directory=".length);
  }
  return null;
}
const DIRECTORY = parseDirectoryArg(process.argv.slice(2));
if (DIRECTORY !== null) config.contribute.directory = DIRECTORY;

// --field <name> (or -f <name>, --field=<name>): system mode only. Use this API
// field as the source image instead of the default boxart (falls back to
// boxart/image when a game lacks it). Overrides config.contribute.sourceField.
function parseFieldArg(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--field" || args[i] === "-f") && args[i + 1] !== undefined)
      return args[i + 1];
    if (args[i].startsWith("--field=")) return args[i].slice("--field=".length);
  }
  return null;
}
const FIELD = parseFieldArg(process.argv.slice(2));
if (FIELD !== null) config.contribute.sourceField = FIELD;

// --startletter <v> (or --startletter=<v>): system mode only. Filter games whose
// media/sort name starts with this letter, or letter range "A-F" (inclusive,
// case-insensitive). Overrides config.contribute.startLetter.
function parseStartLetterArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--startletter" && args[i + 1] !== undefined) return args[i + 1];
    if (args[i].startsWith("--startletter=")) return args[i].slice("--startletter=".length);
  }
  return null;
}
const STARTLETTER = parseStartLetterArg(process.argv.slice(2));
if (STARTLETTER !== null) config.contribute.startLetter = STARTLETTER;

// --port / --ports: the Chrome DevTools debugging port(s) to attach to. Each
// port is a separate Chrome session started with `./start-chrome.sh <port>`
// (its own profile, so its own Gemini/Discord login). Accepts:
//   --port 9222            single port (overrides config.cdpPort)
//   -p 9222 -p 9223        repeated flag → several browsers
//   --ports 9222,9223      comma-separated list → several browsers
// With more than one port, the work queue is built ONCE and dispatched across
// all the browsers in parallel (each item handled by exactly one browser).
function parsePortsArg(args) {
  const ports = [];
  const add = (v) => {
    String(v)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
      .forEach((n) => ports.push(n));
  };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p" || args[i] === "--ports") && args[i + 1] !== undefined)
      add(args[++i]);
    else if (args[i].startsWith("--port=")) add(args[i].slice("--port=".length));
    else if (args[i].startsWith("--ports=")) add(args[i].slice("--ports=".length));
  }
  // De-duplicate while preserving order.
  return [...new Set(ports)];
}
const PORTS = parsePortsArg(process.argv.slice(2));
if (PORTS.length === 1) config.cdpPort = PORTS[0];
// The list of ports to drive: explicit --ports/--port(s), or the single config one.
const RUN_PORTS = PORTS.length ? PORTS : [config.cdpPort];


async function listInputImages() {
  const entries = await fs.readdir(config.inputDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => config.extensions.includes(path.extname(n).toLowerCase()))
    .sort()
    .map((n) => path.join(config.inputDir, n));
}

// Count the "download full-size image" buttons. A new generated image adds one,
// so a rising count is our "generation finished" signal.
async function countDownloadButtons(page) {
  return page.locator(config.selectors.downloadButton).count();
}

// Wait until a NEW download button appears (i.e. generation completed). `baseline`
// is the response text captured just before the prompt was sent, so we only react
// to quota/skip phrases in text that appeared afterwards.
async function waitForGeneration(page, before, timeout, baseline) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await countDownloadButtons(page)) > before) {
      await sleep(1500); // let it settle
      return true;
    }
    // Gemini answered with text instead of an image. Quota (stop the whole run),
    // a transient error (retry this image), or a refusal/clarification (skip it).
    if (await matchResponse(page, config.quotaMessages, baseline)) throw new QuotaReachedError();
    const retry = await matchResponse(page, config.retryMessages, baseline);
    if (retry) {
      const e = new Error(`Gemini hit a transient error — "${retry}"`);
      e.retry = true; // recognised by generateAndSave to re-run the generation
      e.phrase = retry;
      throw e;
    }
    const skip = await matchResponse(page, config.skipMessages, baseline);
    if (skip) {
      const e = new Error(`skipped — Gemini responded: "${skip}"`);
      e.skip = true; // recognised by the run loops (e.g. to remember refusals)
      e.phrase = skip;
      throw e;
    }
    await sleep(2000);
  }
  return false;
}

// Click Gemini's own "download full-size" button on the latest generated image
// and capture the file via the browser download event. Saves to `destBase` +
// the real extension from Gemini's suggested filename (PNG fallback); returns
// that full path.
async function downloadGenerated(page, destBase) {
  const dl = page.locator(config.selectors.downloadButton).last();

  // The download click is flaky (it can open a menu instead of firing the
  // download, or fire nothing). Retry — the image already exists, so this never
  // re-generates and costs no quota.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await dl.scrollIntoViewIfNeeded().catch(() => {});
      // If it's not directly clickable, try opening the export/more-options menu.
      if (!(await dl.isVisible().catch(() => false))) {
        const menu = page.locator(config.selectors.exportMenu).last();
        if (await menu.count()) {
          await menu.click().catch(() => {});
          await sleep(600);
        }
      }
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        dl.click({ timeout: 8000 }),
      ]);
      const dest = destBase + (path.extname(download.suggestedFilename() || "") || ".png");
      await download.saveAs(dest);
      return dest;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        log(`  download retry ${attempt}/2 (${err.message.split("\n")[0]})`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(1000);
      }
    }
  }
  throw lastErr;
}

// Width of the black bar to crop off the RIGHT edge, in pixels (0 if none). A
// pixel only counts as black when every channel is at/below config.borderBlackMax
// — real artwork is never that dark, so this matches only the bar. Only the top
// HALF of each column is inspected, because Gemini's watermark sits in the
// bottom-right and isn't pure black. Two passes, walking in from the right:
//
//   1. The SOLID bar: columns that are at least borderColumnRatio black.
//   2. Then, when borderTrimToClean is on, keep going through the RAGGED edge the
//      model sometimes leaves (columns that still carry SOME black, > the
//      borderEdgeRatio "clean" threshold) until a column that is essentially
//      black-free. This removes the wavy/artefacted boundary so the cut lands in
//      clean artwork — at the cost of a few extra pixels (the resize compensates).
//
// Never reports more than half the width.
function detectRightBorderWidth(image) {
  const { width, height, data } = image.bitmap;
  const blackMax = config.borderBlackMax ?? 0; // max per-channel value still "black"
  const minRatio = config.borderColumnRatio ?? 1; // solid-bar column threshold
  const edgeRatio = config.borderEdgeRatio ?? 0.02; // "clean" threshold for trimming
  const trim = config.borderTrimToClean !== false;
  const maxBorder = Math.floor(width / 2);
  const scanHeight = Math.max(1, Math.floor(height / 2)); // top half only (skip watermark)

  const coverage = (x) => {
    let black = 0;
    for (let y = 0; y < scanHeight; y++) {
      const i = (y * width + x) * 4;
      if (data[i] <= blackMax && data[i + 1] <= blackMax && data[i + 2] <= blackMax) black++;
    }
    return black / scanHeight;
  };

  // 1. The solid black bar.
  let border = 0;
  while (border < maxBorder && coverage(width - 1 - border) >= minRatio) border++;
  if (border === 0) return 0; // no bar at all — leave it to the watermark fallback

  // 2. Trim through the ragged edge until a (near-)black-free column.
  if (trim) {
    while (border < maxBorder && coverage(width - 1 - border) > edgeRatio) border++;
  }
  return border;
}

// Remove Gemini's watermark in place, operating on the Jimp bitmap (raw RGBA).
async function stripWatermark(image) {
  const { width, height, data } = image.bitmap;
  const { imageData, meta } = await removeWatermarkFromImageData(
    { data: new Uint8ClampedArray(data), width, height },
    { adaptiveMode: "auto" }
  );
  image.bitmap.data = Buffer.from(imageData.data);
  image.bitmap.width = imageData.width;
  image.bitmap.height = imageData.height;
  return meta;
}

// Crop off the right strip of the image that holds the (bottom-right) watermark,
// using the library's own size→position math. Returns how many pixels were cut.
function cropOutWatermark(image) {
  const { width, height } = image.bitmap;
  const cfg = detectWatermarkConfig(width, height);
  const pos = calculateWatermarkPosition(width, height, cfg);
  const pad = Math.round(cfg.logoSize * 0.25); // small safety margin
  const keep = Math.max(1, Math.min(width, pos.x - pad)); // everything left of the mark
  image.crop(0, 0, keep, height);
  return width - keep;
}

// Clean up the RIGHT edge (the prompt's black border and Gemini's watermark sit
// there), then resize/crop to target size, save as JPEG. Prefer cropping the
// detected black border; when none is found, fall back to watermark removal.
async function saveOutput(srcPath, outPath) {
  if (!config.detectRightBorder && !config.removeWatermark && !config.resize.enabled) {
    await fs.copyFile(srcPath, outPath);
    return;
  }
  const image = await Jimp.read(srcPath);

  // 1. Crop the black border Gemini was asked to add on the right.
  const border = config.detectRightBorder ? detectRightBorderWidth(image) : 0;
  if (border > 0) {
    const { width, height } = image.bitmap;
    const keep = Math.max(1, width - border);
    image.crop(0, 0, keep, height);
    log(`  detected black border: ${border}px — cropped off the right (${width} → ${keep}px wide)`);
  } else if (config.removeWatermark) {
    // 2. No border detected — fall back to erasing the bottom-right watermark.
    const meta = await stripWatermark(image);
    if (meta.applied) {
      log("  no border detected — watermark: removed");
    } else if (config.cropWatermarkIfNotRemoved) {
      const cut = cropOutWatermark(image);
      log(`  no border detected — watermark not removed (${meta.skipReason}); cropped ${cut}px off the right`);
    } else {
      log(`  no border detected — watermark: skipped (${meta.skipReason})`);
    }
  }

  if (config.resize.enabled) {
    const { width: w, height: h, fit } = config.resize;
    if (fit === "contain") image.contain(w, h);
    else if (fit === "fill") image.resize(w, h); // stretch to exact size
    else image.cover(w, h); // "cover": fill + crop overflow (default)
  }

  image.quality(config.resize.quality);
  await image.writeAsync(outPath);
}

async function attachImage(page, imgPath) {
  // Dismiss any leftover lightbox/overlay/menu from the previous image.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);

  const fileInput = page.locator(config.selectors.fileInput);

  // Most reliable upload path: set files straight onto the <input type=file>.
  // Unlike the OS file-chooser event (which intermittently hangs in setFiles),
  // this resolves as soon as the input accepts the file. Try it whenever an
  // input is present in the DOM.
  const trySetInput = async () => {
    if (!(await fileInput.count())) return false;
    await fileInput.first().setInputFiles(imgPath, { timeout: 10000 });
    return true;
  };
  if (await trySetInput()) return;

  const re = new RegExp(config.selectors.filesMenuItem, "i");
  // The "Fichiers" command: ONLY a visible menuitem/option/button with that text.
  // Restricting to visible + these roles means we never hit chat thumbnails.
  const filesItem = page
    .locator('[role="menuitem"], [role="option"], button')
    .filter({ hasText: re })
    .filter({ visible: true })
    .first();

  // Opening the import menu is flaky (the menu can be slow, or the click can land
  // before it's ready). Retry a few times — this is all before generation, so it
  // costs no quota.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (await trySetInput()) return;

      // Open "Importation et outils", then click the visible "Fichiers" item.
      // Filter to VISIBLE: the per-message "more options" menu trigger echoes the
      // prompt in its aria-label (e.g. "...the attached picture...") and so matches
      // our "attach"/"tools" substrings, but it stays hidden until hover.
      await page
        .locator(config.selectors.importButton)
        .filter({ visible: true })
        .first()
        .click({ timeout: 8000 });
      await filesItem.waitFor({ state: "visible", timeout: 5000 });

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10000 }),
        filesItem.click(),
      ]);
      // Gemini detaches/re-renders the file <input> right after accepting the
      // file, so chooser.setFiles often never resolves and times out EVEN THOUGH
      // the upload succeeded. Treat a setFiles timeout as success (don't retry /
      // re-attach); only a different error means the chooser path truly failed.
      try {
        await chooser.setFiles(imgPath, { timeout: 8000 });
      } catch (err) {
        if (!/timeout/i.test(err.message)) throw err;
        log("  upload: setFiles timed out (file already accepted) — continuing");
      }
      return;
    } catch (err) {
      lastErr = err;
      // The menu may have revealed a file <input> even if the chooser path
      // failed/hung — setting files on it directly is the reliable fallback.
      if (await trySetInput().catch(() => false)) return;
      if (attempt < 3) {
        log(`  attach retry ${attempt}/2 (${err.message.split("\n")[0]})`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(1000);
      }
    }
  }
  throw lastErr;
}

// Generate from `imgPath` and download the result to `genBase` + its real
// extension. Returns that saved path.
async function processOne(page, imgPath, genBase, promptText = config.prompt) {
  // Start from a clean chat so nothing from the previous image is on screen.
  if (config.newChatPerImage) {
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
    await page
      .locator(config.selectors.promptBox)
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await sleep(1000);
  }

  // How many generated images already exist, so we can detect the new one.
  const before = await countDownloadButtons(page);

  // 1. Attach the image via the import menu / file picker.
  await attachImage(page, imgPath);
  log("  attached, waiting for upload preview to settle…");
  await sleep(config.timeouts.uploadSettle);

  // 2. Type the prompt.
  const box = page.locator(config.selectors.promptBox).first();
  await box.click();
  await box.fill(promptText);

  // Snapshot the visible response text BEFORE sending, so quota/skip detection
  // only considers what Gemini adds in reply to THIS prompt (not a restored chat).
  const baseline = await responseText(page);

  // 3. Send (button if present, else Enter).
  const sendBtn = page.locator(config.selectors.sendButton).first();
  if (await sendBtn.count()) {
    await sendBtn.click().catch(() => box.press("Enter"));
  } else {
    await box.press("Enter");
  }
  log("  prompt sent, waiting for generated image…");

  // 4. Wait for generation to finish, then download via Gemini's own button.
  const done = await waitForGeneration(page, before, config.timeouts.generation, baseline);
  if (!done) {
    // Dump what Gemini actually said in reply to this prompt, so unknown
    // quota/refusal wording can be copied into config.quotaMessages/skipMessages.
    const tail = newSinceBaseline(await responseText(page), baseline).slice(-600).trim();
    log(`  (no image) Gemini's reply text was:\n----\n${tail}\n----`);
    throw new Error("timed out waiting for a generated image");
  }
  log("  generated, downloading…");
  return downloadGenerated(page, genBase);
}

async function processTextOnly(page, promptText, genBase) {
  // Start from a clean chat and generate WITHOUT attaching the source image.
  // This is the final fallback for covers that Gemini refuses because they
  // contain a real/public figure.
  if (config.newChatPerImage) {
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
    await page
      .locator(config.selectors.promptBox)
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await sleep(1000);
  }

  const before = await countDownloadButtons(page);

  const box = page.locator(config.selectors.promptBox).first();
  await box.click();
  // Type with real keystrokes instead of fill(): with no image attached, Gemini's
  // send button only enables once the Quill editor sees genuine input events, and
  // a programmatic fill() can leave it disabled — so the prompt would never send
  // and Enter would just add a newline (the run appears stuck on the prompt).
  await box.pressSequentially(promptText);

  const baseline = await responseText(page);

  // Wait for the send button to actually become enabled before clicking it.
  const sendBtn = page.locator(config.selectors.sendButton).first();
  await sendBtn.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  if (await sendBtn.isEnabled().catch(() => false)) {
    await sendBtn.click().catch(() => box.press("Enter"));
  } else {
    await box.press("Enter");
  }
  log("  ultra-fallback text-only prompt sent, waiting for generated image…");

  const done = await waitForGeneration(page, before, config.timeouts.generation, baseline);
  if (!done) {
    const tail = newSinceBaseline(await responseText(page), baseline).slice(-600).trim();
    log(`  (no image) Gemini's reply text was:\n----\n${tail}\n----`);
    throw new Error("timed out waiting for a generated image");
  }
  log("  generated, downloading…");
  return downloadGenerated(page, genBase);
}

// Attach to a real Chrome you launched with `./start-chrome.sh <port>`.
async function connectChrome(port = config.cdpPort) {
  const cdpUrl = `http://${config.cdpHost}:${port}`;
  try {
    return await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    log(`Could not connect to Chrome at ${cdpUrl}`);
    log(`reason: ${err.message}`);
    log(`Start it first in another terminal:  ./start-chrome.sh ${port}`);
    process.exit(1);
  }
}

// Install ONE Ctrl+C/TERM handler that disconnects from every browser (leaves
// YOUR Chrome windows open and running) and exits Node. Disconnecting from a CDP
// connection can hang, which would otherwise leave the process alive after
// Ctrl+C — so force-exit if cleanup takes too long, and exit immediately on a
// second Ctrl+C.
function installShutdown(browsers) {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(130); // second Ctrl+C: don't wait
    shuttingDown = true;
    const force = setTimeout(() => process.exit(130), 3000);
    force.unref();
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// A trivial shared work queue: each worker pulls the next item; returns the
// 0-based original index alongside the value (for stable "(i/total)" logging).
// Safe across concurrent workers because next() does no awaiting — Node runs it
// to completion before another worker's call.
function makeQueue(items) {
  let i = 0;
  return {
    total: items.length,
    next() {
      if (i >= items.length) return null;
      const index = i++;
      return { value: items[index], index };
    },
  };
}

// Find/open the Gemini tab and make sure we're logged in.
async function openGeminiPage(browser) {
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("gemini.google.com"));
  if (!page) {
    page = await context.newPage();
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
  }
  await page.bringToFront();

  // Logged in = NO sign-in button (Gemini shows the prompt box even logged out).
  const isLoggedIn = async () => {
    try {
      if (!page.url().includes("gemini.google.com")) return false;
      return await page.evaluate(
        () =>
          ![...document.querySelectorAll("button,a")].some((b) =>
            /se connecter|sign in|connexion/i.test(
              b.getAttribute("aria-label") || b.textContent || ""
            )
          )
      );
    } catch {
      return false;
    }
  };

  if (!(await isLoggedIn())) {
    log("Not logged into Gemini. Sign in in your Chrome window; it'll continue.");
    while (!(await isLoggedIn())) await sleep(2000);
    log("✓ Gemini ready.");
  }
  return page;
}

// The output file path generateAndSave writes for these inputs (always JPEG when
// config.outputFormat is set, with the configured suffix).
function outputPathFor(outName, ext, outDir = config.outputDir) {
  const outExt = config.outputFormat ? `.${config.outputFormat}` : ext;
  return path.join(outDir, `${outName}${config.outputSuffix}${outExt}`);
}

// Whether the output already exists (so generation would be skipped). Lets the
// run loops short-circuit an already-done item BEFORE downloading its source or
// waiting out the betweenImages pacing delay.
async function outputAlreadyExists(outName, ext, outDir = config.outputDir) {
  if (!config.skipExisting) return false;
  return fs.access(outputPathFor(outName, ext, outDir)).then(() => true).catch(() => false);
}

// Generate fanart from one source image: download the raw result into
// generatedDir (kept), then watermark-remove + resize it into outDir/<outName>.
// Returns the saved output path, or null when generation was skipped because the
// output already existed (so callers can avoid re-uploading an existing image).
async function generateAndSave(geminiPage, sourcePath, outName, ext, outDir = config.outputDir) {
  await fs.mkdir(outDir, { recursive: true });
  const outPath = outputPathFor(outName, ext, outDir);
  if (await outputAlreadyExists(outName, ext, outDir)) {
    log(`  skip ${outName} — output exists`);
    return null;
  }

  const genDir = path.join(config.generatedDir, path.relative(config.outputDir, outDir));
  await fs.mkdir(genDir, { recursive: true });
  const genBase = path.join(genDir, outName);

  const maxAttempts = (config.generationRetries ?? 0) + 1;
  let genPath;
  let fallbackTried = false;
  let ultraFallbackTried = false;

  const isPublicFigureRefusal = (err) => {
    const phrase = String(err.phrase || err.message || "").toLowerCase();
    return (
      err.skip &&
      config.skipMessages.some((m) => phrase.includes(m.toLowerCase()))
    );
  };

  for (let attempt = 1; ; attempt++) {
    try {
      genPath = await processOne(geminiPage, sourcePath, genBase, config.prompt);
      break;
    } catch (err) {
      if (isPublicFigureRefusal(err) && !fallbackTried && config.fallbackPrompt) {
        fallbackTried = true;
        log("  ↳ public figure refusal detected — retrying once with fallback prompt…");
        await sleep(config.timeouts.betweenImages);

        try {
          genPath = await processOne(geminiPage, sourcePath, genBase, config.fallbackPrompt);
          break;
        } catch (fallbackErr) {
          if (isPublicFigureRefusal(fallbackErr) && !ultraFallbackTried && config.ultraFallbackPrompt) {
            ultraFallbackTried = true;
            log("  ↳ fallback refused too — retrying once without the source image…");
            await sleep(config.timeouts.betweenImages);

            const titleOnlyPrompt = config.ultraFallbackPrompt.replaceAll("{name}", outName);
            genPath = await processTextOnly(geminiPage, titleOnlyPrompt, genBase);
            break;
          }
          throw fallbackErr;
        }
      }

      if (err.retry && attempt < maxAttempts) {
        log(`  ⟳ ${err.message} — retry ${attempt}/${maxAttempts - 1}`);
        await sleep(config.timeouts.betweenImages);
        continue;
      }
      throw err;
    }
  }

  log(`  ⬇ generated ${genPath}`);
  await saveOutput(genPath, outPath);
  log(`  ✓ saved ${outPath}`);
  return outPath;
}

// ---- Mode 1: local images directory (the original behaviour) ----
// One worker drains the shared queue on its own browser. Other workers keep
// going if this one hits a hard quota (each browser is a separate account).
async function localWorker(worker, queue, stats) {
  const { tag, geminiPage } = worker;
  for (;;) {
    const item = queue.next();
    if (!item) break;
    const imgPath = item.value;
    const { name, ext } = path.parse(imgPath);
    log(`${tag}(${item.index + 1}/${queue.total}) processing ${name}`);
    // Already done on a previous run — skip without the pacing delay below.
    if (await outputAlreadyExists(name, ext)) {
      log(`${tag}  skip ${name} — output exists`);
      stats.ok++;
      continue;
    }
    let stop = false;
    // Retry the SAME image while we keep hitting the quota, pausing quotaWait
    // each time. Any other outcome leaves this inner loop after one attempt.
    for (;;) {
      try {
        await generateAndSave(geminiPage, imgPath, name, ext);
        stats.ok++;
      } catch (err) {
        if (err.quota) {
          if (config.quotaWait > 0) {
            const mins = Math.round(config.quotaWait / 60000);
            log(`${tag}  ⛔ ${err.message} — waiting ${mins} min, then retrying (quota).`);
            await sleep(config.quotaWait);
            continue; // re-run this same image
          }
          log(`${tag}  ⛔ ${err.message} — this browser stops (daily quota reached).`);
          stop = true;
        } else {
          log(`${tag}  ✗ failed ${name}: ${err.message}`);
          stats.failed++;
        }
      }
      break;
    }
    if (stop) break; // only this worker stops; the others drain the rest
    await sleep(config.timeouts.betweenImages);
  }
}

async function runLocalMode(workers) {
  const images = await listInputImages();
  if (images.length === 0) {
    log(`No images found in ${config.inputDir}. Drop some in and re-run.`);
    return;
  }
  log(
    `Found ${images.length} image(s) to process` +
      (workers.length > 1 ? ` across ${workers.length} browsers.` : ".")
  );

  const queue = makeQueue(images);
  const stats = { ok: 0, failed: 0 };
  await Promise.all(workers.map((w) => localWorker(w, queue, stats)));
  log(`Done. ${stats.ok} succeeded, ${stats.failed} failed.`);
}

async function main() {
  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.mkdir(config.inputDir, { recursive: true });

  const multi = RUN_PORTS.length > 1;
  if (multi) log(`Driving ${RUN_PORTS.length} browsers in parallel: ports ${RUN_PORTS.join(", ")}.`);

  // Connect to every Chrome and prepare a logged-in Gemini page on each. A worker
  // is one browser + its page(s); the run dispatches the queue across all of them.
  const browsers = [];
  const workers = [];
  for (const port of RUN_PORTS) {
    const tag = multi ? `[:${port}] ` : "";
    if (multi) log(`${tag}connecting…`);
    const browser = await connectChrome(port);
    browsers.push(browser);
    const geminiPage = await openGeminiPage(browser);
    workers.push({ port, tag, browser, geminiPage });
  }
  installShutdown(browsers);

  if (SYSTEM) {
    const { runSystemMode } = await import("./system-mode.js");
    await runSystemMode({
      workers,
      system: SYSTEM,
      generateAndSave,
      outputAlreadyExists,
    });
  } else {
    await runLocalMode(workers);
  }

  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
