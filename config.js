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
    // Only process games whose fanart is missing (skip ones that already have it).
    onlyMissingFanart: true,
    // Max number of games to process in one run (0 = no limit). Handy for testing.
    limit: 0,
    // false = generate + save to output/ only (review, upload manually).
    // true  = also upload the generated fanart back into the game's row.
    autoUpload: false,
  },

  // We attach to a REAL Chrome you launch yourself (so Google's login works).
  // `npm run chrome` starts it with this debugging port and profile dir.
  cdpPort: 9222,
  chromeBinary: "google-chrome",
  chromeUserDataDir: "./.gemini-chrome",

  // The same prompt sent with every image.
  prompt:
    "Inspired by the attached picture, create a fanart in the resolution of " +
    "1920x620. With no text and no japanese text, and no game screens or " +
    "arcade machine.",

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

  // Remove Gemini's watermark (bottom-right) before resizing/encoding.
  // Uses @pilio/gemini-watermark-remover (reverse alpha-blending, not AI).
  removeWatermark: true,

  // Image file extensions to pick up from inputDir.
  extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"],

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
