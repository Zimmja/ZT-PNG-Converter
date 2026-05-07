/**
 * Renames subfolders and files whose names contain a configured substring,
 * rewrites embedded paths in ZT1 graphics and text sidecar files, and appends
 * standard [.ai] strings blocks for the duplicate name.
 *
 * Run: node src/convertDirectoryToDuplicate.js (from project root)
 */

const fs = require('fs');
const path = require('path');

const {
  PROJECT_ROOT,
  loadAndValidateForConvertDirectoryToDuplicate,
} = require(path.join(__dirname, 'converterConfig.js'));
const { userError, formatCliError } = require(path.join(__dirname, 'cliError.js'));

// ---------------------------------------------------------------------------
// ZT1 embedded palette path (same layout as duplicatePalette.js)
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function zt1BodyStartOffset(buffer) {
  const isFatz =
    buffer.length >= 9 &&
    buffer[0] === 0x46 &&
    buffer[1] === 0x41 &&
    buffer[2] === 0x54 &&
    buffer[3] === 0x5a;
  return isFatz ? 9 : 0;
}

/**
 * @param {Buffer} buffer
 * @returns {{
 *   pathLenFieldOffset: number,
 *   pathStart: number,
 *   afterPath: number,
 *   paletteRelativePath: string,
 * } | null}
 */
function tryParseZt1PalettePathRegion(buffer) {
  const bodyStart = zt1BodyStartOffset(buffer);
  if (bodyStart + 12 > buffer.length) {
    return null;
  }
  const pathLenFieldOffset = bodyStart + 4;
  const pathLengthWithNull = buffer.readUInt32LE(pathLenFieldOffset);
  const pathCharCount = pathLengthWithNull - 1;
  if (pathCharCount < 0) {
    return null;
  }
  const pathStart = bodyStart + 8;
  if (pathStart + pathLengthWithNull > buffer.length) {
    return null;
  }
  const paletteRelativePath = buffer
    .subarray(pathStart, pathStart + pathCharCount)
    .toString('latin1');
  if (buffer[pathStart + pathCharCount] !== 0) {
    return null;
  }
  const afterPath = pathStart + pathCharCount + 1;
  return {
    pathLenFieldOffset,
    pathStart,
    afterPath,
    paletteRelativePath,
  };
}

/**
 * @param {Buffer} buffer
 * @param {string} newPalettePath
 */
function rebuildZt1WithEmbeddedPalettePath(buffer, newPalettePath) {
  const parsed = tryParseZt1PalettePathRegion(buffer);
  if (!parsed) {
    return null;
  }
  const pathBuf = Buffer.from(newPalettePath, 'latin1');
  const pathWithNull = Buffer.concat([pathBuf, Buffer.from([0])]);
  const pathLengthWithNull = pathWithNull.length;
  const lenField = Buffer.alloc(4);
  lenField.writeUInt32LE(pathLengthWithNull, 0);
  return Buffer.concat([
    buffer.subarray(0, parsed.pathLenFieldOffset),
    lenField,
    pathWithNull,
    buffer.subarray(parsed.afterPath),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const TEXT_EXTENSIONS = new Set([
  '.ani',
  '.ai',
  '.txt',
  '.ini',
  '.cfg',
  '.csv',
  '.xml',
  '.htm',
  '.html',
  '.lua',
]);

/**
 * @param {string} haystack
 * @param {string} needle
 * @param {string} replacement
 */
function replaceAllSubstring(haystack, needle, replacement) {
  if (needle === '') {
    return haystack;
  }
  return haystack.split(needle).join(replacement);
}

/**
 * @param {string} basename
 * @param {string} dirName
 * @param {string} dupName
 */
function renamedBasename(basename, dirName, dupName) {
  return replaceAllSubstring(basename, dirName, dupName);
}

/**
 * @param {string} rootDir
 * @returns {string[]}
 */
function listDirsContaining(rootDir, dirName) {
  /** @type {string[]} */
  const out = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const abs = path.join(current, ent.name);
      walk(abs);
      if (ent.name.includes(dirName)) {
        out.push(abs);
      }
    }
  }

  walk(rootDir);
  out.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return out;
}

/**
 * @param {string} rootDir
 * @returns {string[]}
 */
function listFilesBasenameContaining(rootDir, dirName) {
  /** @type {string[]} */
  const out = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile() && ent.name.includes(dirName)) {
        out.push(abs);
      }
    }
  }

  walk(rootDir);
  out.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return out;
}

/**
 * @param {string} rootDir
 * @param {(fileAbs: string) => void} onFile
 */
function walkFiles(rootDir, onFile) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(abs, onFile);
    } else if (ent.isFile()) {
      onFile(abs);
    }
  }
}

/**
 * @param {string} abs
 * @param {string} dupName
 */
function appendAiStringsBlockIfNeeded(abs, dupName) {
  const ext = path.extname(abs).toLowerCase();
  if (ext !== '.ai') {
    return;
  }
  const buf = fs.readFileSync(abs);
  const text = buf.toString('latin1');
  const marker = `Purchase a ${dupName}.`;
  if (text.includes(marker)) {
    return;
  }
  const block = `

[defaultLCID]
LCID = 1033

[Global]
Type = ${dupName}

[1033]
cLongHelp = Purchase a ${dupName}.
cName = ${dupName}
cTheString = the ${dupName}
`;
  fs.appendFileSync(abs, Buffer.from(block, 'latin1'));
}

/**
 * @param {string} fileAbs
 * @param {string} dirName
 * @param {string} dupName
 * @returns {{ category: 'zt1' | 'text' | 'none', changed: boolean }}
 */
function rewriteFileContent(fileAbs, dirName, dupName) {
  let buf;
  try {
    buf = fs.readFileSync(fileAbs);
  } catch (err) {
    throw userError(`Could not read file:\n${fileAbs}\n${err.message}`);
  }

  const ext = path.extname(fileAbs).toLowerCase();

  const ztParsed = tryParseZt1PalettePathRegion(buf);
  if (ztParsed) {
    const nextPath = replaceAllSubstring(
      ztParsed.paletteRelativePath,
      dirName,
      dupName
    );
    if (nextPath !== ztParsed.paletteRelativePath) {
      const nextBuf = rebuildZt1WithEmbeddedPalettePath(buf, nextPath);
      if (!nextBuf) {
        throw userError(`Could not rebuild ZT1 file after path edit:\n${fileAbs}`);
      }
      fs.writeFileSync(fileAbs, nextBuf);
      return { category: 'zt1', changed: true };
    }
    return { category: 'zt1', changed: false };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const s = buf.toString('latin1');
    const out = replaceAllSubstring(s, dirName, dupName);
    if (out !== s) {
      fs.writeFileSync(fileAbs, Buffer.from(out, 'latin1'));
      return { category: 'text', changed: true };
    }
    return { category: 'text', changed: false };
  }

  return { category: 'none', changed: false };
}

function main() {
  const { duplicateDirAbs, dirName, dupName } =
    loadAndValidateForConvertDirectoryToDuplicate();

  const rootLabel = path.relative(PROJECT_ROOT, duplicateDirAbs) || duplicateDirAbs;

  let dirsRenamed = 0;
  for (const dirAbs of listDirsContaining(duplicateDirAbs, dirName)) {
    const base = path.basename(dirAbs);
    const nextBase = renamedBasename(base, dirName, dupName);
    if (nextBase === base) {
      continue;
    }
    const parent = path.dirname(dirAbs);
    const dest = path.join(parent, nextBase);
    if (fs.existsSync(dest)) {
      throw userError(
        `Cannot rename folder to an existing path:\n${dest}\n` +
          `(while renaming ${dirAbs})`
      );
    }
    fs.renameSync(dirAbs, dest);
    dirsRenamed += 1;
  }

  let filesRenamed = 0;
  for (const fileAbs of listFilesBasenameContaining(duplicateDirAbs, dirName)) {
    const base = path.basename(fileAbs);
    const nextBase = renamedBasename(base, dirName, dupName);
    if (nextBase === base) {
      continue;
    }
    const parent = path.dirname(fileAbs);
    const dest = path.join(parent, nextBase);
    if (fs.existsSync(dest)) {
      throw userError(
        `Cannot rename file to an existing path:\n${dest}\n` +
          `(while renaming ${fileAbs})`
      );
    }
    fs.renameSync(fileAbs, dest);
    filesRenamed += 1;
  }

  let zt1Rewritten = 0;
  let textRewritten = 0;
  let otherFiles = 0;
  /** @type {{ path: string, reason: string }[]} */
  const errors = [];

  walkFiles(duplicateDirAbs, (fileAbs) => {
    try {
      const result = rewriteFileContent(fileAbs, dirName, dupName);
      if (result.changed && result.category === 'zt1') {
        zt1Rewritten += 1;
      } else if (result.changed && result.category === 'text') {
        textRewritten += 1;
      } else if (result.category === 'none') {
        otherFiles += 1;
      }
    } catch (err) {
      errors.push({
        path: fileAbs,
        reason: err && err.message ? err.message : String(err),
      });
    }
  });

  let aiAppended = 0;
  walkFiles(duplicateDirAbs, (fileAbs) => {
    if (path.extname(fileAbs).toLowerCase() !== '.ai') {
      return;
    }
    const before = fs.readFileSync(fileAbs).toString('latin1');
    appendAiStringsBlockIfNeeded(fileAbs, dupName);
    const after = fs.readFileSync(fileAbs).toString('latin1');
    if (after.length > before.length) {
      aiAppended += 1;
    }
  });

  console.log('Convert directory to duplicate: done.');
  console.log('Root:', rootLabel);
  console.log(`Renamed folders (dirName → dupName): ${dirsRenamed}`);
  console.log(`Renamed files (basename contains dirName): ${filesRenamed}`);
  console.log(`ZT1 graphics with embedded path rewritten: ${zt1Rewritten}`);
  console.log(`Text files (.ani / .ai / …) with bytes rewritten: ${textRewritten}`);
  console.log(
    `Other files (e.g. .pal, unknown binary): left as-is unless renamed above: ${otherFiles}`
  );
  console.log(`.ai files appended with [defaultLCID] / [Global] / [1033]: ${aiAppended}`);
  if (errors.length > 0) {
    console.log(`Errors while rewriting files: ${errors.length}`);
    for (const row of errors.slice(0, 40)) {
      const rel = path.relative(PROJECT_ROOT, row.path) || row.path;
      console.log(`  - ${rel}: ${row.reason}`);
    }
    if (errors.length > 40) {
      console.log(`  … and ${errors.length - 40} more`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(formatCliError(err));
  process.exitCode = 1;
}
