// System mode: pull games from the contribute API, and for each game missing
// fanart, download its boxart → generate fanart via Gemini → save to output/.
// (Optionally upload it back to the game's row when contribute.autoUpload=true.)
import { config } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

const siteOrigin = () => new URL(config.contribute.apiUrl).origin;

// Which API field to generate the fanart from. By default boxart, then image;
// a configured contribute.sourceField (or --field) is preferred when present.
// Returns the field name that actually has a value, or null if none do.
const FALLBACK_FIELDS = ["boxart", "image"];
function sourceFieldFor(g) {
  const pref = config.contribute.sourceField;
  const order = pref ? [pref, ...FALLBACK_FIELDS] : FALLBACK_FIELDS;
  return order.find((f) => g[f]) || null;
}
// The media path for that field (or null when the game has none).
const sourceMedia = (g) => {
  const f = sourceFieldFor(g);
  return f ? g[f] : null;
};

// The rompath directory encoded in a game id, relative to the system root, with
// no leading/trailing slash. "subdir/game" -> "subdir"; "game" -> "" (root).
const gameDir = (id) => {
  const s = String(id).replace(/^\/+/, "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i === -1 ? "" : s.slice(0, i);
};

// Normalise the --directory filter to a bare dir. "" (or null) means no filter;
// "/" -> "" (root only); "/subdir/" -> "subdir". Returns null when no filtering.
function directoryFilter() {
  const d = config.contribute.directory;
  if (d === undefined || d === null || d === "") return null;
  return String(d).replace(/^\/+/, "").replace(/\/+$/, "");
}

// --- Refusal memory -------------------------------------------------------
// Games Gemini permanently refuses (e.g. boxart with a public figure) are saved
// per system so we don't waste a prompt retrying them every run.
const refusedFilePath = (system) => path.join(config.outputDir, system, "_refused.json");

async function loadRefused(system) {
  try {
    const data = JSON.parse(await fs.readFile(refusedFilePath(system), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // no file yet / unreadable
  }
}

async function recordRefused(system, entry) {
  const list = await loadRefused(system);
  if (list.some((e) => String(e.id) === String(entry.id))) return; // already noted
  list.push(entry);
  const file = refusedFilePath(system);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 2));
}

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

export async function runSystemMode({
  browser,
  geminiPage,
  system,
  generateAndSave,
  outputAlreadyExists,
}) {
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

  // Game ids Gemini refused before (e.g. public figures) — skip them this run.
  const refused = config.rememberRefusals
    ? new Set((await loadRefused(system)).map((e) => String(e.id)))
    : new Set();
  if (refused.size)
    log(`${refused.size} game(s) previously refused by Gemini — skipping those.`);

  // Optional rompath-directory filter (--directory / contribute.directory).
  const dirFilter = directoryFilter();
  if (dirFilter !== null)
    log(`Directory filter: only games in "/${dirFilter}".`);

  // Which games need fanart?
  let todo = games.filter((g) => {
    if (!sourceMedia(g)) return false; // no boxart or image to generate from
    if (dirFilter !== null && gameDir(g.id) !== dirFilter) return false; // wrong directory
    if (config.contribute.onlyMissingFanart && g.fanart) return false;
    if (alreadyUploaded.has(g.id)) return false; // already uploaded earlier
    if (refused.has(String(g.id))) return false; // refused on a previous run
    return true;
  });
  const total = todo.length;
  if (config.contribute.limit > 0) todo = todo.slice(0, config.contribute.limit);
  log(
    `${total} game(s) need fanart` +
      (todo.length < total ? `; processing first ${todo.length} (limit).` : ".")
  );
  if (todo.length === 0) return;

  // Probe with several sample media so one missing file doesn't break detection.
  const mediaBase = await resolveMediaBase(page, todo.slice(0, 8).map(sourceMedia));

  // Generated fanart goes into output/<system>/; downloaded boxart into tmpDir.
  const outDir = path.join(config.outputDir, system);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });

  let ok = 0;
  let failed = 0;
  let stop = false;
  for (const [i, g] of todo.entries()) {
    const field = sourceFieldFor(g); // which API field we're sourcing from
    const src = sourceMedia(g);
    const ext = path.extname(src) || ".jpg";
    const outName = path.basename(src, ext); // matches media naming
    log(`(${i + 1}/${todo.length}) ${g.name}  [${outName}]${field === "boxart" ? "" : ` (${field})`}`);

    // Already generated on a previous run — skip BEFORE downloading the boxart or
    // waiting out the pacing delay below (so re-runs over a done system fly past).
    if (await outputAlreadyExists(outName, ext, outDir)) {
      log(`  skip ${outName} — output exists`);
      ok++;
      continue;
    }

    const boxTmp = path.join(config.tmpDir, `${outName}.boxart${ext}`);
    // Retry the SAME game while we keep hitting the quota, pausing quotaWait each
    // time. Any other outcome leaves this inner loop after one attempt.
    for (;;) {
      try {
        await downloadToFile(page, mediaBase + encodeURI(src), boxTmp);
        // null = generation was skipped because the output already existed; don't
        // re-upload it (avoids re-uploading media we generated on a previous run).
        const outPath = await generateAndSave(geminiPage, boxTmp, outName, ext, outDir);
        if (outPath && config.contribute.autoUpload) {
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
          if (config.quotaWait > 0) {
            // `finally` removes boxTmp before we wait; it's re-downloaded on retry.
            const mins = Math.round(config.quotaWait / 60000);
            log(`  ⛔ ${err.message} — waiting ${mins} min, then retrying (quota).`);
            await sleep(config.quotaWait);
            continue; // re-run this same game
          }
          // `finally` below still removes boxTmp before we leave the loop.
          log(`  ⛔ ${err.message} — stopping (daily quota reached).`);
          stop = true;
        } else {
          if (err.skip && config.rememberRefusals) {
            await recordRefused(system, {
              id: g.id,
              name: g.name,
              phrase: err.phrase,
              at: new Date().toISOString(),
            }).catch(() => {});
            log("  ↷ remembered refusal — will skip this game on future runs.");
          }
          log(`  ✗ failed ${outName}: ${err.message}`);
          failed++;
        }
      } finally {
        await fs.rm(boxTmp, { force: true }).catch(() => {});
      }
      break;
    }
    if (stop) break;
    if (i < todo.length - 1) await sleep(config.timeouts.betweenImages);
  }
  log(`Done. ${ok} succeeded, ${failed} failed.`);
}
