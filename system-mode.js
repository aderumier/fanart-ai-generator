// System mode: pull games from the contribute API, and for each game missing
// fanart, download its boxart → generate fanart via Gemini → save to output/.
// (Optionally upload it back to the game's row when contribute.autoUpload=true.)
import { config } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

const siteOrigin = () => new URL(config.contribute.apiUrl).origin;

// Open / reuse a tab on the site and land on the system page (ensures we're on
// the authenticated origin so fetches carry the Discord-login cookies).
async function openContributePage(browser, system) {
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes(siteOrigin().split("//")[1]));
  if (!page) page = await context.newPage();
  const target = config.contribute.baseUrl.replace(/\/$/, "") + "/" + system;
  await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.bringToFront();
  return page;
}

// Fetch JSON from a same-origin URL using the page's cookies. Returns the parsed
// body, or null if it wasn't JSON (e.g. a login redirect / HTML page).
async function fetchJson(page, url) {
  return page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: "include" });
      const text = await r.text();
      try {
        return { ok: r.ok, json: JSON.parse(text) };
      } catch {
        return { ok: false, json: null }; // HTML (not logged in / error)
      }
    } catch {
      return { ok: false, json: null };
    }
  }, url);
}

// Wait until the games API returns JSON (i.e. logged into Discord).
async function fetchGamesWhenReady(page, apiUrl) {
  for (let i = 0; i < 600; i++) {
    const res = await fetchJson(page, apiUrl);
    if (res.ok && res.json && Array.isArray(res.json.games)) return res.json.games;
    if (i === 0) log("Waiting for API access — log into Discord in the window if asked…");
    await sleep(2000);
  }
  throw new Error("Could not read the games API (login or URL issue).");
}

// Figure out the base URL that serves media paths, by probing sample boxarts.
// Tries several samples per candidate base: a single game whose boxart 404s (or
// a transient fetch failure) must not break detection for the whole system.
async function resolveMediaBase(page, sampleRelPaths) {
  if (config.contribute.mediaBaseUrl) return config.contribute.mediaBaseUrl.replace(/\/$/, "") + "/";
  const origin = siteOrigin();
  const candidates = ["/media/", "/", "/data/", "/roms/", "/catalog/", "/static/"];
  const samples = (Array.isArray(sampleRelPaths) ? sampleRelPaths : [sampleRelPaths]).filter(Boolean);
  for (const c of candidates) {
    const base = origin + c;
    for (const rel of samples) {
      const url = base + encodeURI(rel);
      const ok = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return r.ok && (r.headers.get("content-type") || "").startsWith("image");
        } catch {
          return false;
        }
      }, url);
      if (ok) {
        log(`Media base resolved: ${base}`);
        return base;
      }
    }
  }
  throw new Error(
    `Could not resolve the media base URL from ${samples.length} sample(s). ` +
      "Set contribute.mediaBaseUrl in config.js (e.g. the site origin + \"/media/\")."
  );
}

// Upload a generated fanart file back to the site (multipart, same-origin so the
// session cookie rides along). Mirrors the site's own /api/media/upload call.
async function uploadFanart(page, { filePath, filename, system, gameId }) {
  const b64 = (await fs.readFile(filePath)).toString("base64");
  const res = await page.evaluate(
    async ({ b64, filename, system, gameId, url }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "image/jpeg" }), filename);
      fd.append("system", system);
      fd.append("game_id", gameId);
      fd.append("media_type", "fanart");
      try {
        const r = await fetch(url, { method: "POST", body: fd, credentials: "include" });
        return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    },
    { b64, filename, system, gameId, url: config.contribute.uploadUrl }
  );
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${res.body}`);
  return res;
}

// Download a same-origin image to a local file via the page's cookies.
async function downloadToFile(page, url, destPath) {
  const base64 = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, url);
  await fs.writeFile(destPath, Buffer.from(base64, "base64"));
}

export async function runSystemMode({ browser, geminiPage, system, generateAndSave }) {
  log(`System mode: ${system}`);
  const page = await openContributePage(browser, system);

  const apiUrl = config.contribute.apiUrl.replace(/\/$/, "") + "/" + system;
  const games = await fetchGamesWhenReady(page, apiUrl);
  log(`API returned ${games.length} game(s).`);

  // Game ids that already have an uploaded (pending-review) fanart — skip these
  // so we don't regenerate/re-upload them on a later run.
  const pending = await fetchJson(page, config.contribute.pendingUrl);
  const alreadyUploaded = new Set(
    (pending.json?.pending_media || [])
      .filter((m) => m.system === system && m.fieldname === "fanart")
      .map((m) => m.game_id)
  );
  if (alreadyUploaded.size)
    log(`${alreadyUploaded.size} game(s) already have an uploaded fanart — skipping those.`);

  // Which games need fanart?
  let todo = games.filter((g) => {
    if (!g.boxart) return false; // nothing to generate from
    if (config.contribute.onlyMissingFanart && g.fanart) return false;
    if (alreadyUploaded.has(g.id)) return false; // already uploaded earlier
    return true;
  });
  const total = todo.length;
  if (config.contribute.limit > 0) todo = todo.slice(0, config.contribute.limit);
  log(
    `${total} game(s) need fanart` +
      (todo.length < total ? `; processing first ${todo.length} (limit).` : ".")
  );
  if (todo.length === 0) return;

  // Probe with several boxarts so one missing file doesn't break detection.
  const mediaBase = await resolveMediaBase(page, todo.slice(0, 8).map((g) => g.boxart));

  // Generated fanart goes into output/<system>/; downloaded boxart into tmpDir.
  const outDir = path.join(config.outputDir, system);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });

  let ok = 0;
  let failed = 0;
  for (const [i, g] of todo.entries()) {
    const ext = path.extname(g.boxart) || ".jpg";
    const outName = path.basename(g.boxart, ext); // matches media naming
    log(`(${i + 1}/${todo.length}) ${g.name}  [${outName}]`);

    const boxTmp = path.join(config.tmpDir, `${outName}.boxart${ext}`);
    try {
      await downloadToFile(page, mediaBase + encodeURI(g.boxart), boxTmp);
      const outPath = await generateAndSave(geminiPage, boxTmp, outName, ext, outDir);
      if (config.contribute.autoUpload) {
        await uploadFanart(page, {
          filePath: outPath,
          filename: path.basename(outPath),
          system,
          gameId: g.id,
        });
        log("  ⬆ uploaded fanart");
      }
      ok++;
    } catch (err) {
      if (err.quota) {
        // `finally` below still removes boxTmp before we leave the loop.
        log(`  ⛔ ${err.message} — stopping (daily quota reached).`);
        break;
      }
      log(`  ✗ failed ${outName}: ${err.message}`);
      failed++;
    } finally {
      await fs.rm(boxTmp, { force: true }).catch(() => {});
    }
    if (i < todo.length - 1) await sleep(config.timeouts.betweenImages);
  }
  log(`Done. ${ok} succeeded, ${failed} failed.`);
}
