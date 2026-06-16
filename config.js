// All tunable settings live here. Edit selectors if Gemini's UI changes.
//
// When running the COMPILED binary, these defaults are baked in. To change them
// without recompiling, drop a `config.json` next to the binary with just the
// keys you want to override (deep-merged over the defaults below).
import { readFileSync } from "node:fs";
import path from "node:path";

export const config = {
  // Where Gemini lives.
  url: "https://gemini.google.com/app",

  // Folders (relative to this project).
  inputDir: "./images",
  outputDir: "./output",
  // Where the RAW image downloaded from Gemini is kept (before watermark removal
  // + resize). The processed result goes to outputDir. Mirrors outputDir's
  // subdirectory layout (e.g. system mode -> generated/<system>/).
  generatedDir: "./generated",
  // Scratch dir for downloaded source images (boxart) before processing.
  tmpDir: "./tmp",

  // Source for the "system" mode (run with --system <name>). The page lists
  // games; for each one missing fanart we grab its boxart, generate, and upload.
  // With no --system argument, the local inputDir above is used instead.
  contribute: {
    baseUrl: "https://rgs-retro.ddns.net/contribute/system/",
    // API returning the games list for a system (system name is appended).
    apiUrl: "https://rgs-retro.ddns.net/api/catalog/contribute/games/",
    // Base for media paths from the API (e.g. boxart "dos/media/box2d/x.jpg").
    // Leave "" to auto-detect by probing a few common bases.
    mediaBaseUrl: "",
    // Endpoint that accepts the generated fanart (multipart upload).
    uploadUrl: "https://rgs-retro.ddns.net/api/media/upload",
    // Endpoint listing already-uploaded (pending-review) media, so we can skip
    // games we already uploaded fanart for on a previous run.
    pendingUrl: "https://rgs-retro.ddns.net/api/media/pending",
    // Only process games whose fanart is missing (skip ones that already have it).
    onlyMissingFanart: true,
    // Max number of games to process in one run (0 = no limit). Handy for testing.
    limit: 0,
    // Filter games by the rompath directory encoded in their game id (also via
    // --directory). "" = no filter (all games); "/" = games in the root only;
    // "/subdir" = only games whose rom is in that subdirectory.
    directory: "",
    // Filter games by the first letter of their media/sort name (also via
    // --startletter). "" = no filter; "A" = only names starting with A; "A-F" =
    // a letter range (inclusive, case-insensitive). Handy for batching a system
    // in alphabetical chunks across several runs.
    startLetter: "",
    // Which API field to use as the source image (also via --field). "" = default
    // (boxart, then image). Set another field name (e.g. "image", "screenshot")
    // to prefer it; it still falls back to boxart/image when a game lacks it.
    sourceField: "",
    // false = generate + save to output/ only (review, upload manually).
    // true  = also upload the generated fanart back to the game (media_type=fanart).
    autoUpload: true,
  },

  // We attach to a REAL Chrome you launch yourself (so Google's login works).
  // `npm run chrome` starts it with this debugging port and profile dir.
  // Use 127.0.0.1 (not "localhost") — Chrome binds IPv4 only, and some runtimes
  // resolve "localhost" to IPv6 ::1 first, which fails to connect.
  cdpHost: "127.0.0.1",
  cdpPort: 9222,
  chromeBinary: "google-chrome",
  chromeUserDataDir: "./.gemini-chrome",

  // The same prompt sent with every image.
  prompt:
    "Inspired by the attached picture, create an ultra-wide 3:1 banner fanart. " +
    "Reserve the rightmost 5% of the width as a solid pure-black (#000000) " +
    "vertical bar; the artwork must fill the remaining left portion edge to edge. " +
    "No text, no japanese text, no game screens or arcade machines.",

  // Output is always saved as JPEG at this quality, resized to width x height.
  resize: {
    enabled: true,
    width: 1920,
    height: 620,
    // "cover" = fill the frame and crop overflow (no distortion, may crop edges).
    // "contain" = fit whole image inside, padding the rest. "fill" = stretch.
    fit: "cover",
    // JPEG quality (1-100).
    quality: 90,
  },

  // Output file format/extension. Saved as JPEG regardless of the source type.
  outputFormat: "jpg",

  // Right-edge cleanup before resizing (the prompt's black border and Gemini's
  // bottom-right watermark both live there). Applied in order:
  // 1. detectRightBorder: find the solid PURE-BLACK vertical bar on the right and
  //    crop it off with a clean, straight vertical cut. A pixel only counts as
  //    black when every channel is <= borderBlackMax, and a column only counts as
  //    the bar when it is black over the inspected height (top half, to skip the
  //    watermark) — so the cut lands at the same x top and bottom.
  // 2. removeWatermark: when NO bar is detected, fall back to erasing the
  //    watermark with @pilio/gemini-watermark-remover (reverse alpha-blending).
  // 3. cropWatermarkIfNotRemoved: if that removal can't detect/remove the mark,
  //    crop off the right strip that holds it instead.
  detectRightBorder: true,
  // Max per-channel value (0-255) a pixel may have and still count as bar black.
  // Gemini's "pure black" bar comes back as #000000 plus a little render/PNG
  // noise (pixels up to ~#080808), so an exact 0 match finds nothing. 8 absorbs
  // that noise while staying far darker than any real artwork; set 0 for an exact
  // #000000-only match.
  borderBlackMax: 8,
  // Fraction of a column (top half) that must be black for it to count as part of
  // the bar. The walk starts at the rightmost column, so requiring ~all of it
  // (1.0) makes a single imperfect edge column abort detection; 0.5 ("mostly
  // black") tolerates edge/anti-aliasing noise and cuts through the bar's soft
  // edge cleanly, while still rejecting real artwork (which is far from black).
  borderColumnRatio: 0.5,
  removeWatermark: true,
  cropWatermarkIfNotRemoved: true,

  // Image file extensions to pick up from inputDir.
  extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"],

  // Phrases Gemini shows when you've hit the daily image-generation quota.
  // If the latest response contains any of these (case-insensitive substring),
  // we pause for `quotaWait` ms and retry the SAME image (see quotaWait below).
  // Add more variants here as you encounter them.
  quotaMessages: [
    "I can't create more images for you today",
    "I can't create more images for you right now",
    "can't create more images",
    "I can't generate more images for you today",
    "can't generate more images",
    "come back tomorrow and we can make more",
    "as soon as your limit resets",
    "Check your usage in Settings",
    // French equivalents (Gemini follows the UI language).
    "Je ne peux pas créer d'images supplémentaires aujourd'hui",
    "je ne peux pas créer plus d'images",
    "plus d'images pour aujourd'hui",
  ],

  // When a quotaMessages phrase is hit, how long to wait (ms) before retrying the
  // same image, instead of stopping the run. The daily quota typically frees up
  // over time, so we sleep and try again. Set to 0 to stop the run immediately
  // (the old behaviour). Default: 1 hour.
  quotaWait: 60 * 60 * 1000,

  // Phrases where Gemini hit a TRANSIENT error and asks us to try again. The
  // generation is re-run (up to generationRetries times) instead of skipped.
  retryMessages: [
    "I encountered an error doing what you asked",
    "Je ne suis pas parvenu à faire ce que vous avez demandé",
    "Please try your request again",
    "something went wrong",
  ],
  // How many times to re-run a generation after a retryMessages match.
  generationRetries: 2,

  // Phrases that mean THIS image won't be generated, but the run should continue.
  // If the latest response matches any of these, we SKIP to the next game right
  // away instead of waiting out the full generation timeout. (Not a quota stop.)
  skipMessages: [
    "I can create images of people",
    "Je peux créer des images de personnes",
    // Refuses to depict real/public figures (e.g. boxart with a celebrity).
    "I can't depict some public figures",
    "depict some public figures",
    "Je ne peux pas représenter certaines personnalités publiques",
    // Blocked over third-party content/IP (editing the prompt won't help us).
    "interests of third-party content providers",
  ],

  // Remember games that Gemini refused (a skipMessage match) in a per-system file
  // (output/<system>/_refused.json) and skip them automatically on future runs,
  // since these refusals are permanent. Delete the file to retry them.
  rememberRefusals: true,

  // Timing (milliseconds).
  timeouts: {
    // How long to wait for a generated image to appear after sending.
    generation: 180000,
    // Polite pause between images so it looks less robotic.
    betweenImages: 8000,
    // How long the upload preview should settle before sending the prompt.
    uploadSettle: 4000,
  },

  // Run with a visible window (true) so you can watch / intervene. headless is
  // riskier with Google's bot checks.
  headless: false,

  // Output filename = source name + this suffix + extension. Empty = identical
  // name to the source image (saved in outputDir). E.g. "_fanart" to tag them.
  outputSuffix: "",

  // Start a FRESH Gemini chat before each image. Strongly recommended: it stops
  // the previous image/overlays from leaking into the next upload. Implemented
  // by reloading the app, which opens a new conversation.
  newChatPerImage: true,

  // Skip an input image if its output file already exists (resume support).
  skipExisting: true,

  // ---- Selectors. These are the brittle part; tweak here if the UI changes. ----
  selectors: {
    // The "+ / Import & tools" button that opens the upload menu (FR + EN).
    importButton:
      'button[aria-label*="Importation" i], button[aria-label*="import" i], button[aria-label*="outils" i], button[aria-label*="tools" i], button[aria-label*="upload" i], button[aria-label*="attach" i]',
    // Regex (string) matching the "Files" menu item that opens the file picker.
    filesMenuItem: "fichiers|files|upload|importer|t[ée]l[ée]charg",
    // Direct file input, if one ever exists (used as a fast path).
    fileInput: 'input[type="file"]',
    // The contenteditable prompt box (Gemini uses a Quill editor).
    promptBox:
      'div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], rich-textarea div[contenteditable="true"]',
    // Send button (French "Envoyer"); only appears once there's text/an image.
    sendButton:
      'button[aria-label*="Envoyer" i], button[aria-label*="Send" i], button[aria-label*="Submit" i], button.send-button',
    // Container holding model responses (used to scope where we look for images).
    responseArea: "main",
    // "Download full-size image" button on a generated image.
    downloadButton:
      'button[aria-label*="Télécharger" i], button[aria-label*="Download" i], [role="menuitem"][aria-label*="Télécharger" i], [role="menuitem"][aria-label*="Download" i]',
    // Menu that may need opening before the download item is visible.
    exportMenu:
      'button[aria-label*="exporter" i], button[aria-label*="export" i], button[aria-label*="plus d\'options" i], button[aria-label*="more options" i]',
  },
};

// Deep-merge plain objects from `source` into `target` (arrays/scalars replace).
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object") {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

// Apply ./config.json (next to the binary / cwd) over the defaults, if present.
try {
  const overrides = JSON.parse(
    readFileSync(path.join(process.cwd(), "config.json"), "utf8")
  );
  deepMerge(config, overrides);
} catch {
  // No config.json (or unreadable/invalid) — just use the defaults above.
}
