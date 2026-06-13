// Inspects the CURRENT Gemini conversation to understand how generated images
// and their download controls are structured. Run AFTER a generation exists in
// the open chat. Does not send anything.
import { chromium } from "playwright-core";
import { config } from "./config.js";

const browser = await chromium.connectOverCDP(`http://localhost:${config.cdpPort}`);
const ctx = browser.contexts()[0];
const page =
  ctx.pages().find((p) => p.url().includes("gemini.google.com")) || ctx.pages()[0];
await page.bringToFront();

process.on("SIGINT", async () => {
  await browser.close().catch(() => {});
  process.exit(0);
});

const info = await page.evaluate(() => {
  const root = document.querySelector("main") || document.body;

  const imgs = [...root.querySelectorAll("img")].map((img, i) => {
    const src = img.currentSrc || img.src || "";
    return {
      i,
      w: img.naturalWidth,
      h: img.naturalHeight,
      kind: src.slice(0, 16),
      srcTail: src.slice(-40),
      // is it inside a user-sent message vs a model response?
      ctx: (img.closest("user-query, [data-test-id]")?.tagName || "?").toLowerCase(),
    };
  });

  // Buttons that look download/export/share/more related.
  const btns = [...root.querySelectorAll("button,a,[role=button],[role=menuitem]")]
    .map((b) => (b.getAttribute("aria-label") || b.title || b.textContent || "").trim())
    .filter((t) =>
      /t[ée]l[ée]charg|download|export|enregistr|save|partag|share|plus|more|options/i.test(
        t
      )
    )
    .filter((t) => t.length < 50);

  return { imgs, btns: [...new Set(btns)] };
});

console.log("\n--- images in the conversation ---");
for (const im of info.imgs)
  console.log(
    `#${im.i}  ${im.w}x${im.h}  kind=${im.kind}  ctx=${im.ctx}  …${im.srcTail}`
  );

console.log("\n--- download/export/more-like controls present ---");
console.log(info.btns.length ? info.btns.join("\n") : "(none found)");

console.log("\nDone. (your Chrome stays open)");
await browser.close();
