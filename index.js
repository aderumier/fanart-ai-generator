import { chromium } from "playwright";
import sharp from "sharp";
import { config } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);


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

// Wait until a NEW download button appears (i.e. generation completed).
async function waitForGeneration(page, before, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await countDownloadButtons(page)) > before) {
      await sleep(1500); // let it settle
      return true;
    }
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

// Resize/crop the downloaded file to the target size (or copy as-is).
async function saveOutput(srcPath, outPath) {
  if (config.resize.enabled) {
    // sharp infers the output format from outPath's extension.
    await sharp(srcPath)
      .resize(config.resize.width, config.resize.height, { fit: config.resize.fit })
      .toFile(outPath);
  } else {
    await fs.copyFile(srcPath, outPath);
  }
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
  await page.locator(config.selectors.importButton).first().click();
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

  // 3. Send (button if present, else Enter).
  const sendBtn = page.locator(config.selectors.sendButton).first();
  if (await sendBtn.count()) {
    await sendBtn.click().catch(() => box.press("Enter"));
  } else {
    await box.press("Enter");
  }
  log("  prompt sent, waiting for generated image…");

  // 4. Wait for generation to finish, then download via Gemini's own button.
  const done = await waitForGeneration(page, before, config.timeouts.generation);
  if (!done) throw new Error("timed out waiting for a generated image");
  log("  generated, downloading…");
  return downloadGenerated(page, tmpPath);
}

async function main() {
  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.mkdir(config.inputDir, { recursive: true });

  // Attach to the real Chrome you launched with `npm run chrome`.
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${config.cdpPort}`);
  } catch {
    log(`Could not connect to Chrome on port ${config.cdpPort}.`);
    log("Start it first in another terminal:  npm run chrome");
    process.exit(1);
  }

  const context = browser.contexts()[0];
  // Reuse the Gemini tab if open, otherwise open one.
  let page = context.pages().find((p) => p.url().includes("gemini.google.com"));
  if (!page) {
    page = await context.newPage();
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
  }
  await page.bringToFront();

  // Disconnecting (not closing your Chrome) on Ctrl+C.
  const shutdown = async () => {
    try {
      await browser.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Detect login by the ABSENCE of a sign-in button (Gemini shows the prompt
  // box even when logged out).
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
    log("Not logged in. Sign into Gemini in your Chrome window, then it'll continue.");
    const deadline = Date.now() + Number.MAX_SAFE_INTEGER;
    while (!(await isLoggedIn()) && Date.now() < deadline) await sleep(2000);
    log("✓ Logged in. Continuing.");
  }

  const images = await listInputImages();
  if (images.length === 0) {
    log(`No images found in ${config.inputDir}. Drop some in and re-run.`);
    await browser.close();
    return;
  }
  log(`Found ${images.length} image(s) to process.`);

  let ok = 0;
  let failed = 0;
  for (const [i, imgPath] of images.entries()) {
    const { name, ext } = path.parse(imgPath); // name = no extension
    // Same filename as the source image (plus optional suffix), in outputDir.
    const outPath = path.join(config.outputDir, `${name}${config.outputSuffix}${ext}`);

    if (config.skipExisting) {
      const exists = await fs
        .access(outPath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        log(`(${i + 1}/${images.length}) skip ${name} — output exists`);
        continue;
      }
    }

    log(`(${i + 1}/${images.length}) processing ${name}`);
    const tmpPath = path.join(config.outputDir, `.${name}.download`);
    try {
      await processOne(page, imgPath, tmpPath);
      await saveOutput(tmpPath, outPath);
      await fs.rm(tmpPath, { force: true });
      log(`  ✓ saved ${outPath}`);
      ok++;
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      log(`  ✗ failed ${name}: ${err.message}`);
      failed++;
    }

    if (i < images.length - 1) await sleep(config.timeouts.betweenImages);
  }

  log(`Done. ${ok} succeeded, ${failed} failed.`);
  // Disconnect from CDP. This leaves YOUR Chrome window open and running.
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
