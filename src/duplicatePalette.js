/**
 * Duplicates the entity .pal next to a subtype folder and rewrites every ZT1
 * graphic under that subtype so the embedded palette path keeps the same
 * directory prefix but points at the new .pal file name.
 *
 * Run: node src/duplicatePalette.js (from project root)
 */

const fs = require('fs');
const path = require('path');

const {
  PROJECT_ROOT,
  loadAndValidateForDuplicatePalette,
} = require(path.join(__dirname, 'converterConfig.js'));
const { userError, formatCliError } = require(path.join(__dirname, 'cliError.js'));

// ---------------------------------------------------------------------------
// ZT1 container: optional FATZ (9 bytes) + animation uint32 + path length uint32
// + path (latin1) + NUL + frame count + frames…
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
 * Replaces only the final path segment (palette file name); keeps the rest of
 * the embedded string byte-for-byte, including slash style.
 *
 * @param {string} embeddedPath
 * @param {string} newPaletteBasename
 */
function embeddedPathWithNewPaletteBasename(embeddedPath, newPaletteBasename) {
  const lastSlash = Math.max(
    embeddedPath.lastIndexOf('/'),
    embeddedPath.lastIndexOf('\\')
  );
  const dir =
    lastSlash >= 0 ? embeddedPath.slice(0, lastSlash + 1) : '';
  return dir + newPaletteBasename;
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

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listPaletteFilesInDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.pal'))
    .map((name) => path.join(dir, name));
}

/**
 * Depth-first file walk; visits files only.
 *
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
 * @param {string} subtypeDirAbs
 * @returns {string | null}
 */
function findFirstParsableZt1Path(subtypeDirAbs) {
  let found = null;
  walkFiles(subtypeDirAbs, (fileAbs) => {
    if (found !== null) {
      return;
    }
    if (fileAbs.toLowerCase().endsWith('.pal')) {
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(fileAbs);
    } catch {
      return;
    }
    if (tryParseZt1PalettePathRegion(buf) !== null) {
      found = fileAbs;
    }
  });
  return found;
}

/**
 * @param {string} entityRootAbs
 * @param {string} subtypeDirAbs
 * @returns {string}
 */
function resolveSourcePalettePath(entityRootAbs, subtypeDirAbs) {
  const pals = listPaletteFilesInDir(entityRootAbs);
  if (pals.length === 0) {
    throw userError(
      `No .pal file found next to the subtype folder. Expected a palette in:\n${entityRootAbs}`
    );
  }
  if (pals.length === 1) {
    return pals[0];
  }
  const sampleZt = findFirstParsableZt1Path(subtypeDirAbs);
  if (!sampleZt) {
    throw userError(
      `Several .pal files are in "${entityRootAbs}" and the subtype folder has no ZT1 file ` +
        'to read the embedded palette name from. Remove extra .pal files or add a valid ZT1 graphic.'
    );
  }
  const buf = fs.readFileSync(sampleZt);
  const parsed = tryParseZt1PalettePathRegion(buf);
  if (!parsed) {
    throw userError(
      `Could not read embedded palette path from sample file:\n${sampleZt}`
    );
  }
  const embeddedBase = path.basename(
    parsed.paletteRelativePath.replace(/\\/g, '/')
  );
  const match = pals.find(
    (p) => path.basename(p).toLowerCase() === embeddedBase.toLowerCase()
  );
  if (!match) {
    throw userError(
      `Several .pal files are in "${entityRootAbs}". The sample ZT1 file embeds palette ` +
        `"${embeddedBase}", but no file with that name exists there. Align names or reduce to one .pal.`
    );
  }
  return match;
}

/**
 * @param {string} sourcePalAbs
 * @param {string} subtypeName
 * @returns {string}
 */
function duplicatePaletteFilename(sourcePalAbs, subtypeName) {
  const dir = path.dirname(sourcePalAbs);
  const ext = path.extname(sourcePalAbs);
  const stem = path.basename(sourcePalAbs, ext);
  const safeSubtype = subtypeName.replace(/[/\\]/g, '_');
  return path.join(dir, `${stem}_${safeSubtype}${ext}`);
}

function main() {
  const { subtypeDirAbs, entityRootAbs, subtypeName } =
    loadAndValidateForDuplicatePalette();

  const sourcePalAbs = resolveSourcePalettePath(entityRootAbs, subtypeDirAbs);
  const destPalAbs = duplicatePaletteFilename(sourcePalAbs, subtypeName);
  const newPaletteBasename = path.basename(destPalAbs);

  if (path.resolve(sourcePalAbs) === path.resolve(destPalAbs)) {
    throw userError(
      'The duplicate palette path matches the source palette. Choose a different subtype folder name.'
    );
  }

  if (fs.existsSync(destPalAbs)) {
    throw userError(
      `The duplicate palette file already exists:\n${destPalAbs}\n` +
        'Delete or rename it if you want to run this again from a fresh copy of the source palette.'
    );
  }

  fs.copyFileSync(sourcePalAbs, destPalAbs);

  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  let updated = 0;

  walkFiles(subtypeDirAbs, (fileAbs) => {
    if (fileAbs.toLowerCase().endsWith('.pal')) {
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(fileAbs);
    } catch (err) {
      skipped.push({
        path: fileAbs,
        reason: `Could not read file (${err.message})`,
      });
      return;
    }
    const parsed = tryParseZt1PalettePathRegion(buf);
    if (!parsed) {
      skipped.push({
        path: fileAbs,
        reason: 'Not a ZT1 graphic (unrecognised header / palette path block)',
      });
      return;
    }
    const nextEmbedded = embeddedPathWithNewPaletteBasename(
      parsed.paletteRelativePath,
      newPaletteBasename
    );
    const nextBuf = rebuildZt1WithEmbeddedPalettePath(buf, nextEmbedded);
    if (!nextBuf) {
      skipped.push({
        path: fileAbs,
        reason: 'Failed to rebuild file after editing palette path',
      });
      return;
    }
    fs.writeFileSync(fileAbs, nextBuf);
    updated += 1;
  });

  console.log('Duplicate palette: done.');
  console.log('Source palette:', sourcePalAbs);
  console.log('New palette file:', destPalAbs);
  console.log('Embedded palette file name:', newPaletteBasename);
  console.log(`Updated ZT1 files: ${updated}`);
  if (skipped.length > 0) {
    console.log(`Skipped non-ZT or unreadable files: ${skipped.length}`);
    for (const row of skipped) {
      const rel = path.relative(PROJECT_ROOT, row.path) || row.path;
      console.log(`  - ${rel}: ${row.reason}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(formatCliError(err));
  process.exitCode = 1;
}
