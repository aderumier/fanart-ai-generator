// All tunable settings live here. Edit selectors if Gemini's UI changes.

export const config = {
  // Where Gemini lives.
  url: "https://gemini.google.com/app",

  // Folders (relative to this project).
  inputDir: "./images",
  outputDir: "./output",

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

  // Target output size. Set resize.enabled = false to keep Gemini's raw output.
  resize: {
    enabled: true,
    width: 1920,
    height: 620,
    // "cover" = fill the frame and crop overflow (no distortion, may crop edges).
    // "contain" = fit whole image inside, padding the rest. "fill" = stretch.
    fit: "cover",
  },

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
