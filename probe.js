// Diagnostic: opens Gemini with your saved session and reports what it finds.
// Does NOT send anything. Sign in if prompted, then watch the console.
import { chromium } from "playwright-core";
import { config } from "./config.js";

let browser;
try {
  browser = await chromium.connectOverCDP(`http://localhost:${config.cdpPort}`);
} catch {
  console.error(`Could not connect to Chrome on port ${config.cdpPort}.`);
  console.error("Start it first:  npm run chrome");
  process.exit(1);
}

// Ctrl+C just disconnects; it leaves your Chrome running.
const shutdown = async () => {
  try {
    await browser.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes("gemini.google.com"));
if (!page) {
  page = await ctx.newPage();
  await page.goto(config.url, { waitUntil: "domcontentloaded" });
}
await page.bringToFront();
await page.waitForTimeout(2000);

const count = (sel) => page.locator(sel).count();

// Are we logged in? Look for a sign-in button.
const signInButtons = await page.evaluate(
  () =>
    [...document.querySelectorAll("button,a")].filter((b) =>
      /se connecter|sign in|connexion/i.test(
        b.getAttribute("aria-label") || b.textContent || ""
      )
    ).length
);
console.log("\n--- login state ---");
console.log(
  signInButtons > 0
    ? `✗ NOT logged in (${signInButtons} sign-in button(s)). Click "Se connecter" and log in, then re-run.`
    : "✓ Looks logged in (no sign-in button found)."
);

console.log("\n--- selectors at rest ---");
console.log(`promptBox: ${await count(config.selectors.promptBox)}`);
console.log(`fileInput: ${await count('input[type="file"]')}`);

// Find and click the import / tools button to expose the upload menu.
console.log("\n--- opening the import/tools menu ---");
const importBtn = page
  .locator(
    'button[aria-label*="Importation" i], button[aria-label*="import" i], button[aria-label*="tools" i], button[aria-label*="outils" i], button[aria-label*="add" i], button[aria-label*="plus" i]'
  )
  .first();
if (await importBtn.count()) {
  console.log("clicking:", await importBtn.getAttribute("aria-label"));
  await importBtn.click();
  await page.waitForTimeout(1200);

  const items = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"], button, [role="option"]')]
      .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim())
      .filter((t) => t && t.length < 50)
  );
  console.log("menu items now visible:");
  console.log([...new Set(items)].join("\n"));
  console.log(`\nfileInput after opening menu: ${await count('input[type="file"]')}`);
} else {
  console.log("✗ could not find an import/tools button.");
}

console.log("\nLeaving browser open. Ctrl+C to quit.");
await new Promise(() => {});
