const fs = require('fs');
const path = require('path');

const { userError } = require(path.join(__dirname, 'cliError.js'));
const {
  isLauncherMode,
  isSafeBasename,
  normalizeForwardSlashes,
  normalizePaletteFilename,
} = require(path.join(__dirname, 'converterLocalSettings.js'));

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'Config.txt');

/**
 * Every supported key: human description after `;` on each line (do not edit key names).
 * Values in DEFAULT_VALUES seed a new Config.txt when the file is missing.
 */
const CONFIG_KEY_DEFS = {
  zt1SourceDirPath: {
    description:
      'ZT1 source directory: relative to project root; place extensionless graphic (N or n) and .pal files here.',
  },
  pngOutputPath: {
    description:
      'PNG output path: relative to project root; folder and file base name for the exported PNG (.png optional).',
  },
  sourcePngPath: {
    description:
      'Source PNG path: relative to project root; input PNG for PNG → ZT1 (.png extension optional).',
  },
  zt1EmbeddedPalettePath: {
    description:
      'Embedded palette path: virtual path written inside the ZT graphic (forward slashes, include the .pal file name).',
  },
  zt1GraphicOutputPath: {
    description:
      'ZT graphic output path: relative to project root; extensionless output file for the ZT1 graphic.',
  },
  zt1PaletteOutputPath: {
    description:
      'Palette output path: relative to project root; .pal file written on disk (.pal optional).',
  },
  frameOffsetX: {
    description:
      'Frame offset X: horizontal placement in the ZT graphic (pixels); used when running from the GUI launcher.',
  },
  frameOffsetY: {
    description:
      'Frame offset Y: vertical placement in the ZT graphic (pixels); used when running from the GUI launcher.',
  },
  duplicatePaletteSubtypeDirPath: {
    description:
      'Duplicate palette: relative path to a subtype folder (e.g. duplicate/y); a .pal file must sit in the parent folder next to this folder.',
  },
};

const DEFAULT_VALUES = {
  zt1SourceDirPath: 'source-zt1',
  pngOutputPath: 'output-png/zt1-output.png',
  sourcePngPath: 'source-png/zt1-output.png',
  zt1EmbeddedPalettePath: 'animals/lion/icflion/icflion.pal',
  zt1GraphicOutputPath: 'output-zt1/N',
  zt1PaletteOutputPath: 'output-zt1/icflion.pal',
  frameOffsetX: '22',
  frameOffsetY: '16',
  duplicatePaletteSubtypeDirPath: '',
};

/** @type {{ heading: string, keys: string[] }[]} */
const CONFIG_SECTIONS = [
  { heading: '; ZT1 → PNG', keys: ['zt1SourceDirPath', 'pngOutputPath'] },
  {
    heading: '; PNG → ZT1',
    keys: [
      'sourcePngPath',
      'zt1EmbeddedPalettePath',
      'zt1GraphicOutputPath',
      'zt1PaletteOutputPath',
      'frameOffsetX',
      'frameOffsetY',
    ],
  },
  {
    heading: '; Duplicate palette',
    keys: ['duplicatePaletteSubtypeDirPath'],
  },
];

const REQUIRED_ZT1_TO_PNG = ['zt1SourceDirPath', 'pngOutputPath'];

const REQUIRED_PNG_TO_ZT1_BASE = [
  'sourcePngPath',
  'zt1EmbeddedPalettePath',
  'zt1GraphicOutputPath',
  'zt1PaletteOutputPath',
];

const REQUIRED_PNG_TO_ZT1_LAUNCHER = ['frameOffsetX', 'frameOffsetY'];

const REQUIRED_DUPLICATE_PALETTE = ['duplicatePaletteSubtypeDirPath'];

function configFileExists() {
  return fs.existsSync(CONFIG_PATH);
}

function isConfigEditable() {
  try {
    if (configFileExists()) {
      fs.accessSync(CONFIG_PATH, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(PROJECT_ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} line
 * @returns {object | null}
 */
function parseConfigLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) {
    return null;
  }
  const key = line.slice(0, colon).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
    return null;
  }
  let rest = line.slice(colon + 1).trim();
  let value = '';
  if (rest.startsWith('"')) {
    const endQuote = rest.indexOf('"', 1);
    if (endQuote === -1) {
      return null;
    }
    value = rest.slice(1, endQuote);
    rest = rest.slice(endQuote + 1).trim();
  } else {
    const descSep = rest.indexOf(' ;');
    if (descSep >= 0) {
      value = rest.slice(0, descSep).trim();
    } else {
      value = rest.trim();
    }
  }
  return { key, value };
}

function parseConfigFile(text) {
  /** @type {Record<string, string>} */
  const values = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const parsed = parseConfigLine(trimmed);
    if (parsed) {
      values[parsed.key] = parsed.value;
    }
  }
  return values;
}

function listKeysPresentInFile(text) {
  const keys = new Set();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const parsed = parseConfigLine(trimmed);
    if (parsed) {
      keys.add(parsed.key);
    }
  }
  return keys;
}

function escapeForDoubleQuotedConfig(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatConfigLine(key) {
  const def = CONFIG_KEY_DEFS[key];
  if (!def) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const raw = DEFAULT_VALUES[key];
  const valuePart =
    raw === undefined || raw === ''
      ? '""'
      : `"${escapeForDoubleQuotedConfig(raw)}"`;
  return `${key}: ${valuePart} ; ${def.description}`;
}

function buildDefaultConfigBody() {
  const parts = [];
  for (const section of CONFIG_SECTIONS) {
    parts.push(section.heading);
    for (const key of section.keys) {
      parts.push(formatConfigLine(key));
    }
    parts.push('');
  }
  return parts.join('\n');
}

function createConfigFileIfMissing() {
  if (configFileExists()) {
    return;
  }
  if (!isConfigEditable()) {
    throw userError(
      `Config.txt is missing and could not be created (folder not writable):\n${CONFIG_PATH}`
    );
  }
  fs.writeFileSync(CONFIG_PATH, buildDefaultConfigBody(), 'utf8');
}

/**
 * Appends lines for keys that are not already declared in the file (empty value + description).
 * @param {string[]} requiredKeys
 */
function appendMissingKeyLines(requiredKeys) {
  if (!configFileExists() || !isConfigEditable()) {
    return;
  }
  let content = fs.readFileSync(CONFIG_PATH, 'utf8');
  const present = listKeysPresentInFile(content);
  const toAdd = requiredKeys.filter((k) => !present.has(k));
  if (toAdd.length === 0) {
    return;
  }
  const block = toAdd
    .map((k) => {
      const def = CONFIG_KEY_DEFS[k];
      return `${k}: "" ; ${def.description}`;
    })
    .join('\n');
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  content += '\n' + block + '\n';
  fs.writeFileSync(CONFIG_PATH, content, 'utf8');
}

/**
 * Resolves a relative path under the project root (file or directory). Rejects ".." and absolute paths.
 * @param {string} relativePath
 * @param {string} label
 */
function resolveProjectRelativePath(relativePath, label) {
  const t = String(relativePath).trim().replace(/\\/g, '/');
  if (t === '' || t.startsWith('/') || /^[a-zA-Z]:/.test(t)) {
    throw userError(
      `${label} in Config.txt must be a non-empty relative path (not absolute).`
    );
  }
  const segments = t.split('/').filter(Boolean);
  if (segments.some((seg) => seg === '..')) {
    throw userError(`${label} in Config.txt must not contain "..".`);
  }
  const abs = path.resolve(PROJECT_ROOT, ...segments);
  const root = path.resolve(PROJECT_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw userError(`${label} must resolve inside the project folder.`);
  }
  return abs;
}

/**
 * @param {string} rel
 * @param {string} label
 */
function parsePngOutputPathSpec(rel, label) {
  const t = String(rel).trim().replace(/\\/g, '/');
  const abs = resolveProjectRelativePath(t, label);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let baseNoExt = base;
  if (/\.png$/i.test(base)) {
    baseNoExt = base.slice(0, -4);
  }
  if (!isSafeBasename(baseNoExt)) {
    throw userError(
      `${label} must end with a simple file name (no extra slashes in the name part). Got "${base}".`
    );
  }
  const outputPngAbs = path.join(dir, `${baseNoExt}.png`);
  return { outputPngAbs, outputDir: dir, basenameNoExt: baseNoExt };
}

/**
 * @param {string} rel
 * @param {string} label
 */
function parseSourcePngPathSpec(rel, label) {
  const t = String(rel).trim().replace(/\\/g, '/');
  const abs = resolveProjectRelativePath(t, label);
  const dir = path.dirname(abs);
  let base = path.basename(abs);
  if (!/\.png$/i.test(base)) {
    base = `${base}.png`;
  }
  const sourcePngAbs = path.join(dir, base);
  const baseNoExt = base.replace(/\.png$/i, '');
  if (!isSafeBasename(baseNoExt)) {
    throw userError(
      `${label} must end with a simple file name (no extra slashes in the name part). Got "${base}".`
    );
  }
  return { sourcePngAbs, sourcePngDir: dir, basenameNoExt: baseNoExt };
}

/**
 * @param {string} rel
 * @param {string} label
 */
function parseZt1GraphicOutputPathSpec(rel, label) {
  const abs = resolveProjectRelativePath(String(rel).trim(), label);
  const base = path.basename(abs);
  if (!isSafeBasename(base)) {
    throw userError(
      `${label} must end with a simple extensionless file name. Got "${base}".`
    );
  }
  return abs;
}

/**
 * @param {string} rel
 * @param {string} label
 */
function parseZt1PaletteOutputPathSpec(rel, label) {
  const abs = resolveProjectRelativePath(String(rel).trim(), label);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const withPal = normalizePaletteFilename(base);
  return path.join(dir, withPal);
}

function collectEmptyOrMissing(requiredKeys, values) {
  const missing = [];
  const empty = [];
  for (const key of requiredKeys) {
    if (!(key in values)) {
      missing.push(key);
      continue;
    }
    if (String(values[key]).trim() === '') {
      empty.push(key);
    }
  }
  return { missing, empty };
}

function formatKeyList(keys) {
  return keys.map((k) => `  ${k}`).join('\n');
}

/**
 * @param {string[]} requiredKeys
 */
function validateAndLoad(requiredKeys) {
  createConfigFileIfMissing();
  let text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const presentInFile = listKeysPresentInFile(text);
  const missingFromFile = requiredKeys.filter((k) => !presentInFile.has(k));

  if (missingFromFile.length > 0 && isConfigEditable()) {
    appendMissingKeyLines(requiredKeys);
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  }

  const values = parseConfigFile(text);
  const { missing, empty } = collectEmptyOrMissing(requiredKeys, values);

  if (missing.length > 0 || empty.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(
        'These required keys are missing from Config.txt:\n' +
          formatKeyList(missing)
      );
    }
    if (empty.length > 0) {
      parts.push(
        'These keys are present but empty — set a value in Config.txt:\n' +
          formatKeyList(empty)
      );
    }
    parts.push(`Config file: ${CONFIG_PATH}`);
    throw userError(parts.join('\n\n'));
  }

  return values;
}

function parseIntSetting(raw, keyLabel) {
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) {
    throw userError(
      `${keyLabel} in Config.txt must be a whole number (no decimals).`
    );
  }
  return n;
}

function loadAndValidateForZt1ToPng() {
  const values = validateAndLoad(REQUIRED_ZT1_TO_PNG);
  const zt1SourceDirAbs = resolveProjectRelativePath(
    values.zt1SourceDirPath,
    'zt1SourceDirPath'
  );
  const pngOutputParsed = parsePngOutputPathSpec(
    values.pngOutputPath,
    'pngOutputPath'
  );
  return {
    values,
    zt1SourceDirAbs,
    pngOutputParsed,
  };
}

function validateEmbeddedPalettePath(raw) {
  const s = normalizeForwardSlashes(String(raw).trim());
  if (s === '' || s.includes('..')) {
    throw userError(
      'zt1EmbeddedPalettePath in Config.txt must not be empty and must not contain "..".'
    );
  }
  return s;
}

function loadAndValidateForDuplicatePalette() {
  const values = validateAndLoad(REQUIRED_DUPLICATE_PALETTE);
  const subtypeDirAbs = resolveProjectRelativePath(
    values.duplicatePaletteSubtypeDirPath,
    'duplicatePaletteSubtypeDirPath'
  );
  if (!fs.existsSync(subtypeDirAbs)) {
    throw userError(
      `duplicatePaletteSubtypeDirPath must be an existing folder. Not found:\n${subtypeDirAbs}`
    );
  }
  const st = fs.statSync(subtypeDirAbs);
  if (!st.isDirectory()) {
    throw userError(
      `duplicatePaletteSubtypeDirPath must be a directory, not a file:\n${subtypeDirAbs}`
    );
  }
  return {
    values,
    subtypeDirAbs,
    entityRootAbs: path.dirname(subtypeDirAbs),
    subtypeName: path.basename(subtypeDirAbs),
  };
}

function loadAndValidateForPngToZt1() {
  const required = [...REQUIRED_PNG_TO_ZT1_BASE];
  if (isLauncherMode()) {
    required.push(...REQUIRED_PNG_TO_ZT1_LAUNCHER);
  }
  const values = validateAndLoad(required);

  const sourcePngParsed = parseSourcePngPathSpec(
    values.sourcePngPath,
    'sourcePngPath'
  );
  const embeddedPalettePath = validateEmbeddedPalettePath(
    values.zt1EmbeddedPalettePath
  );
  const outputGraphicPath = parseZt1GraphicOutputPathSpec(
    values.zt1GraphicOutputPath,
    'zt1GraphicOutputPath'
  );
  const outputPalPath = parseZt1PaletteOutputPathSpec(
    values.zt1PaletteOutputPath,
    'zt1PaletteOutputPath'
  );

  const ztGraphicBasename = path.basename(outputGraphicPath);

  let frameOffsetX;
  let frameOffsetY;
  if (isLauncherMode()) {
    frameOffsetX = parseIntSetting(values.frameOffsetX, 'frameOffsetX');
    frameOffsetY = parseIntSetting(values.frameOffsetY, 'frameOffsetY');
  }

  return {
    values,
    sourcePngAbs: sourcePngParsed.sourcePngAbs,
    sourcePngDir: sourcePngParsed.sourcePngDir,
    outputGraphicPath,
    outputPalPath,
    embeddedPalettePath,
    ztGraphicBasename,
    inputBasename: sourcePngParsed.basenameNoExt,
    frameOffsetX,
    frameOffsetY,
  };
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  CONFIG_KEY_DEFS,
  CONFIG_SECTIONS,
  DEFAULT_VALUES,
  REQUIRED_ZT1_TO_PNG,
  REQUIRED_PNG_TO_ZT1_BASE,
  REQUIRED_PNG_TO_ZT1_LAUNCHER,
  REQUIRED_DUPLICATE_PALETTE,
  configFileExists,
  isConfigEditable,
  createConfigFileIfMissing,
  parseConfigFile,
  resolveProjectRelativePath,
  loadAndValidateForZt1ToPng,
  loadAndValidateForPngToZt1,
  loadAndValidateForDuplicatePalette,
};
