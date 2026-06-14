import { chromium } from "playwright-core";
import Jimp from "jimp";
import { removeWatermarkFromImageData } from "@pilio/gemini-watermark-remover";
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
  const valueFlags = new Set(["--system", "-s", "--limit", "-l"]);
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
    // Gemini answered with text instead of an image. Either we're out of quota
    // (stop the whole run) or it refused/clarified this one (skip to next).
    if (await matchResponse(page, config.quotaMessages, baseline)) throw new QuotaReachedError();
    const skip = await matchResponse(page, config.skipMessages, baseline);
    if (skip) throw new Error(`skipped — Gemini responded: "${skip}"`);
    await sleep(2000);
  }
  return false;
}

// Click Gemini's own "download full-size" button on the latest generated image
// and capture the file via the browser download event. Returns the temp path.
async function downloadGenerated(page, tmpPath) {
  const dl = page.locator(config.selectors.downloadButton).last();
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
    dl.click(),
  ]);
  await download.saveAs(tmpPath);
  return tmpPath;
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

// Optionally de-watermark, then resize/crop to target size, save as JPEG.
async function saveOutput(srcPath, outPath) {
  if (!config.removeWatermark && !config.resize.enabled) {
    await fs.copyFile(srcPath, outPath);
    return;
  }
  const image = await Jimp.read(srcPath);

  if (config.removeWatermark) {
    const meta = await stripWatermark(image);
    log(`  watermark: ${meta.applied ? "removed" : `skipped (${meta.skipReason})`}`);
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

  // Fast path: a file input already exists in the DOM.
  const existing = page.locator(config.selectors.fileInput);
  if (await existing.count()) {
    await existing.first().setInputFiles(imgPath);
    return;
  }

  const re = new RegExp(config.selectors.filesMenuItem, "i");
  // The "Fichiers" command: ONLY a visible menuitem/option/button with that text.
  // Restricting to visible + these roles means we never hit chat thumbnails.
  const filesItem = page
    .locator('[role="menuitem"], [role="option"], button')
    .filter({ hasText: re })
    .filter({ visible: true })
    .first();

  // Open "Importation et outils", then click the visible "Fichiers" item.
  // Filter to VISIBLE: the per-message "more options" menu trigger echoes the
  // prompt in its aria-label (e.g. "...the attached picture...") and so matches
  // our "attach"/"tools" substrings, but it stays hidden until hover.
  await page
    .locator(config.selectors.importButton)
    .filter({ visible: true })
    .first()
    .click();
  await filesItem.waitFor({ state: "visible", timeout: 5000 });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15000 }),
    filesItem.click(),
  ]);
  await chooser.setFiles(imgPath);
}

async function processOne(page, imgPath, tmpPath) {
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
  await box.fill(config.prompt);

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
  return downloadGenerated(page, tmpPath);
}

// Attach to the real Chrome you launched with `npm run chrome`.
async function connectChrome() {
  let browser;
  const cdpUrl = `http://${config.cdpHost}:${config.cdpPort}`;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    log(`Could not connect to Chrome at ${cdpUrl}`);
    log(`reason: ${err.message}`);
    log("Start it first in another terminal:  npm run chrome");
    process.exit(1);
  }
  // Ctrl+C disconnects (leaves YOUR Chrome open and running).
  const shutdown = async () => {
    try {
      await browser.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return browser;
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

// Generate fanart from one source image and save it to outputDir/<outName><ext>.
// Returns the saved path, or null if the output already existed (skipped).
async function generateAndSave(geminiPage, sourcePath, outName, ext, outDir = config.outputDir) {
  await fs.mkdir(outDir, { recursive: true });
  // Output is always JPEG regardless of the source extension.
  const outExt = config.outputFormat ? `.${config.outputFormat}` : ext;
  const outPath = path.join(outDir, `${outName}${config.outputSuffix}${outExt}`);
  if (config.skipExisting) {
    const exists = await fs.access(outPath).then(() => true).catch(() => false);
    if (exists) {
      log(`  skip ${outName} — output exists`);
      return outPath;
    }
  }
  await fs.mkdir(config.tmpDir, { recursive: true });
  const tmpPath = path.join(config.tmpDir, `${outName}.download`);
  try {
    await processOne(geminiPage, sourcePath, tmpPath);
    await saveOutput(tmpPath, outPath);
    log(`  ✓ saved ${outPath}`);
    return outPath;
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// ---- Mode 1: local images directory (the original behaviour) ----
async function runLocalMode(geminiPage) {
  const images = await listInputImages();
  if (images.length === 0) {
    log(`No images found in ${config.inputDir}. Drop some in and re-run.`);
    return;
  }
  log(`Found ${images.length} image(s) to process.`);

  let ok = 0;
  let failed = 0;
  for (const [i, imgPath] of images.entries()) {
    const { name, ext } = path.parse(imgPath);
    log(`(${i + 1}/${images.length}) processing ${name}`);
    try {
      await generateAndSave(geminiPage, imgPath, name, ext);
      ok++;
    } catch (err) {
      if (err.quota) {
        log(`  ⛔ ${err.message} — stopping (daily quota reached).`);
        break;
      }
      log(`  ✗ failed ${name}: ${err.message}`);
      failed++;
    }
    if (i < images.length - 1) await sleep(config.timeouts.betweenImages);
  }
  log(`Done. ${ok} succeeded, ${failed} failed.`);
}

async function main() {
  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.mkdir(config.inputDir, { recursive: true });

  const browser = await connectChrome();
  const geminiPage = await openGeminiPage(browser);

  if (SYSTEM) {
    const { runSystemMode } = await import("./system-mode.js");
    await runSystemMode({ browser, geminiPage, system: SYSTEM, generateAndSave });
  } else {
    await runLocalMode(geminiPage);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
