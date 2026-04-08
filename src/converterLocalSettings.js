const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const LOCAL_DIR = path.join(PROJECT_ROOT, '.local');
const SETTINGS_PATH = path.join(LOCAL_DIR, 'converter-settings.json');

const DEFAULT_ZT1_TO_PNG_OUTPUT_BASENAME = 'zt1-output';
const DEFAULT_PNG_TO_ZT1_INPUT_BASENAME = 'zt1-output';
const DEFAULT_IMAGE_PATH = 'animals/lion/icflion';
const DEFAULT_ZT_FILENAME = 'N';
const DEFAULT_PALETTE_FILENAME = 'icflion';

function defaultSettings() {
  return {
    zt1ToPngOutputBasename: DEFAULT_ZT1_TO_PNG_OUTPUT_BASENAME,
    pngToZt1InputBasename: DEFAULT_PNG_TO_ZT1_INPUT_BASENAME,
    pngToZt1: {
      imagePath: DEFAULT_IMAGE_PATH,
      ztFilename: DEFAULT_ZT_FILENAME,
      paletteFilename: DEFAULT_PALETTE_FILENAME,
    },
  };
}

function isSafeBasename(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return false;
  }
  const t = name.trim();
  if (t.includes('/') || t.includes('\\') || t.includes('..')) {
    return false;
  }
  return true;
}

function normalizeForwardSlashes(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Palette label "icflion" → "icflion.pal" for disk / embedded tail.
 */
function normalizePaletteFilename(name) {
  const t = String(name).trim();
  if (t.toLowerCase().endsWith('.pal')) {
    return t;
  }
  return `${t}.pal`;
}

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeDeep(base[k] || {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadSettings() {
  const defaults = defaultSettings();
  if (!fs.existsSync(SETTINGS_PATH)) {
    return defaults;
  }
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeDeep(defaults, parsed);
  } catch {
    return defaults;
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = mergeDeep(current, partial);
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function isLauncherMode() {
  return process.env.ZT_CONVERTER_FROM_LAUNCHER === '1';
}

module.exports = {
  PROJECT_ROOT,
  LOCAL_DIR,
  SETTINGS_PATH,
  defaultSettings,
  loadSettings,
  saveSettings,
  isLauncherMode,
  isSafeBasename,
  normalizeForwardSlashes,
  normalizePaletteFilename,
  DEFAULT_ZT1_TO_PNG_OUTPUT_BASENAME,
  DEFAULT_PNG_TO_ZT1_INPUT_BASENAME,
  DEFAULT_IMAGE_PATH,
  DEFAULT_ZT_FILENAME,
  DEFAULT_PALETTE_FILENAME,
};
