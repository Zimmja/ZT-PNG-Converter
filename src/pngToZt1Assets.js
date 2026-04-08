const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  mergeClosestPairOfOpaqueColours,
} = require(path.join(__dirname, 'mergeClosestOpaqueColours.js'));
const {
  loadSettings,
  saveSettings,
  isLauncherMode,
  isSafeBasename,
  normalizeForwardSlashes,
  normalizePaletteFilename,
  DEFAULT_PNG_TO_ZT1_INPUT_BASENAME,
  DEFAULT_IMAGE_PATH,
  DEFAULT_ZT_FILENAME,
  DEFAULT_PALETTE_FILENAME,
} = require(path.join(__dirname, 'converterLocalSettings.js'));
const { createRl, ask } = require(path.join(__dirname, 'converterReadline.js'));
const { userError, formatCliError } = require(path.join(__dirname, 'cliError.js'));
const {
  writeColorCompressionReport,
} = require(path.join(__dirname, 'colorCompressionReport.js'));

// Project root (parent of src/)
const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_ZT1_DIR = path.join(PROJECT_ROOT, 'output-zt1');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ANIMATION_SPEED_MS = 1000;

// ---------------------------------------------------------------------------
// PNG decode (8-bit RGBA only)
// ---------------------------------------------------------------------------

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function unfilterScanline(filterType, scanline, previousLine, bpp, outOffset, outBuffer) {
  const length = scanline.length;
  for (let x = 0; x < length; x++) {
    let raw = scanline[x];
    const left = x >= bpp ? outBuffer[outOffset + x - bpp] : 0;
    const up = previousLine ? previousLine[x] : 0;
    const upLeft = previousLine && x >= bpp ? previousLine[x - bpp] : 0;
    if (filterType === 0) {
      // None
    } else if (filterType === 1) {
      raw = (raw + left) & 255;
    } else if (filterType === 2) {
      raw = (raw + up) & 255;
    } else if (filterType === 3) {
      raw = (raw + Math.floor((left + up) / 2)) & 255;
    } else if (filterType === 4) {
      raw = (raw + paethPredictor(left, up, upLeft)) & 255;
    } else {
      throw userError(
        'This PNG uses a compression mode the tool does not support. Try re-exporting from your image editor.'
      );
    }
    outBuffer[outOffset + x] = raw;
  }
}

function decodePngRgba(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw userError('This file is not a PNG. Choose a .png file exported from your image editor.');
  }

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idatParts = [];

  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    offset += 4;
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    offset += 4;
    const chunkData = buffer.subarray(offset, offset + chunkLength);
    offset += chunkLength;
    offset += 4;

    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
    } else if (chunkType === 'IDAT') {
      idatParts.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }
  }

  if (width === undefined || height === undefined) {
    throw userError('The PNG looks damaged (missing image header). Try exporting the file again.');
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw userError(
      'Only 8-bit RGBA PNGs are supported. In your editor, export as PNG with transparency (alpha channel).'
    );
  }

  const bpp = 4;
  const rowByteCount = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const expectedSize = height * (1 + rowByteCount);
  if (inflated.length !== expectedSize) {
    throw userError(
      'The PNG image data looks inconsistent or damaged. Try opening and re-exporting the file.'
    );
  }

  const rgba = Buffer.alloc(width * height * bpp);
  let inPos = 0;
  let previousRow = null;

  for (let y = 0; y < height; y++) {
    const filterType = inflated[inPos];
    inPos += 1;
    const scanline = inflated.subarray(inPos, inPos + rowByteCount);
    inPos += rowByteCount;
    const outOffset = y * rowByteCount;
    const currentRow = rgba.subarray(outOffset, outOffset + rowByteCount);
    unfilterScanline(filterType, scanline, previousRow, bpp, outOffset, rgba);
    previousRow = currentRow;
  }

  return { width, height, rgba };
}

function getPixel(rgba, width, x, y) {
  const i = (y * width + x) * 4;
  return {
    r: rgba[i],
    g: rgba[i + 1],
    b: rgba[i + 2],
    a: rgba[i + 3],
  };
}

// ---------------------------------------------------------------------------
// Palette (max 256 entries; index 0 is black)
//
// ---------------------------------------------------------------------------

const TRANSPARENT_ALPHA_THRESHOLD = 128;

const rgbKey = (r, g, b) => `${r},${g},${b}`;

/**
 * Counts distinct RGB triples among pixels with alpha ≥ threshold (these need
 * palette slots besides shared handling of “see-through” pixels).
 */
function countDistinctOpaqueRgb(width, height, rgba) {
  const distinct = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = getPixel(rgba, width, x, y);
      if (p.a >= TRANSPARENT_ALPHA_THRESHOLD) {
        distinct.add(rgbKey(p.r, p.g, p.b));
      }
    }
  }
  return distinct;
}

/**
 * ZT1 allows 256 indices. Index 0 is black. Opaque pixels need one entry per
 * distinct RGB; indices 1–255 fit at most 255 non-black colours. Transparent
 * pixels (alpha < threshold) all map to index 0 and do not add new colours.
 */
function opaqueExceedsPaletteLimit(width, height, rgba) {
  return countDistinctOpaqueRgb(width, height, rgba).size > 255
}

/**
 * Index 0 is black. Pixels with alpha below the threshold map to index 0.
 * Other opaque colours are assigned indices in order of first appearance.
 * 
 * 
 * 
 * 
 * 
 * 
 * 
 */
function buildPaletteFromRgba(width, height, rgba) {
  const palette = [{ r: 0, g: 0, b: 0 }];
  const opaqueIndexByRgb = new Map();

  function opaqueIndexForRgb(r, g, b) {
    const key = rgbKey(r, g, b);
    if (opaqueIndexByRgb.has(key)) {
      return opaqueIndexByRgb.get(key);
    }
    if (palette.length >= 256) {
      throw userError(
        'Internal error while building the colour table. Try running the conversion again.'
      );
    }
    const idx = palette.length;
    palette.push({ r, g, b });
    opaqueIndexByRgb.set(key, idx);
    return idx;
  }

  const indexGrid = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = getPixel(rgba, width, x, y);
      let idx;
      if (p.a < TRANSPARENT_ALPHA_THRESHOLD) {
        idx = 0;
      } else {
        idx = opaqueIndexForRgb(p.r, p.g, p.b);
      }
      indexGrid[y * width + x] = idx;
    }
  }

  return { palette, indexGrid };
}

/**
 * clsPalette.WritePal — header: uint16 LE colour count + 2 zero bytes; then
 * R, G, B, A per entry (index 0 written as opaque black).
 */
function writePalFile(filePath, palette) {
  const count = palette.length;
  const header = Buffer.alloc(4);
  header.writeUInt16LE(count, 0);
  header.writeUInt16LE(0, 2);

  const body = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    const c = palette[i];
    const o = i * 4;
    body[o] = c.r;
    body[o + 1] = c.g;
    body[o + 2] = c.b;
    body[o + 3] = 0xff;
  }
  fs.writeFileSync(filePath, Buffer.concat([header, body]));
}

// ---------------------------------------------------------------------------
// Frame row encoding (ClsFrame.BitMapToHex + clsDrawingInstr)
// ---------------------------------------------------------------------------

/**
 * ZT Studio stores uint16 values as two bytes with the hex-nibble pairs
 * reversed (see StringExtensions.ReverseHex in ZT Studio).
 */
function writeUInt16ZT(value) {
  const hex = value.toString(16).padStart(4, '0');
  const pair0 = hex.slice(0, 2);
  const pair1 = hex.slice(2, 4);
  return Buffer.from([parseInt(pair1, 16), parseInt(pair0, 16)]);
}

function writeOffsetPair(signedOffset) {
  let value;
  if (signedOffset >= 0) {
    value = signedOffset;
  } else {
    value = 256 * 256 + signedOffset;
  }
  return writeUInt16ZT(value);
}

function readUInt16BEFromBytes(lowByte, highByte) {
  return (highByte << 8) | lowByte;
}

/**
 * Returns the raw payload of frame 0 from a ZT1 graphic (basic or FATZ header).
 */
function extractFirstFrameBuffer(graphicBuffer) {
  let offset = 0;
  if (
    graphicBuffer.length >= 9 &&
    graphicBuffer[0] === 0x46 &&
    graphicBuffer[1] === 0x41 &&
    graphicBuffer[2] === 0x54 &&
    graphicBuffer[3] === 0x5a
  ) {
    offset = 9;
  }
  if (offset + 12 > graphicBuffer.length) {
    throw userError(
      'The reference graphic file (for alignment) is too small or damaged. Remove it or replace it with a valid ZT1 file.'
    );
  }
  offset += 4;
  const pathLengthWithNull = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  const pathCharCount = pathLengthWithNull - 1;
  if (pathCharCount < 0 || offset + pathLengthWithNull > graphicBuffer.length) {
    throw userError(
      'The reference graphic file looks damaged (palette path length is invalid).'
    );
  }
  offset += pathCharCount;
  if (graphicBuffer[offset] !== 0) {
    throw userError(
      'The reference graphic file looks damaged (palette path is not in the expected format).'
    );
  }
  offset += 1;

  const frameCount = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  if (frameCount < 1) {
    throw userError(
      'The reference graphic has no frames inside it, so alignment cannot be copied from it.'
    );
  }
  const frameByteLength = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  if (offset + frameByteLength > graphicBuffer.length) {
    throw userError(
      'The reference graphic file ends unexpectedly. It may be incomplete or damaged.'
    );
  }
  return graphicBuffer.subarray(offset, offset + frameByteLength);
}

/**
 * Reads width, height, offset X/Y, and mystery bytes from a frame payload
 * (same interpretation as the decoder / ZT Studio ClsFrame).
 */
function parseFrameHeaderPlacement(frameBytes) {
  if (frameBytes.length < 10) {
    throw userError(
      'The reference graphic frame data is too short to read. Try a different reference file.'
    );
  }
  const refHeight = readUInt16BEFromBytes(frameBytes[0], frameBytes[1]);
  const refWidth = readUInt16BEFromBytes(frameBytes[2], frameBytes[3]);

  let offsetY;
  if (frameBytes[5] === 0xff) {
    offsetY =
      ((256 * 256) - readUInt16BEFromBytes(frameBytes[4], frameBytes[5])) * -1;
  } else {
    offsetY = readUInt16BEFromBytes(frameBytes[4], frameBytes[5]);
    if (offsetY >= 0x8000) {
      offsetY -= 0x10000;
    }
  }

  let offsetX;
  if (frameBytes[7] === 0xff) {
    offsetX =
      ((256 * 256) - readUInt16BEFromBytes(frameBytes[6], frameBytes[7])) * -1;
  } else {
    offsetX = readUInt16BEFromBytes(frameBytes[6], frameBytes[7]);
    if (offsetX >= 0x8000) {
      offsetX -= 0x10000;
    }
  }

  return {
    refWidth,
    refHeight,
    offsetX,
    offsetY,
    mystery0: frameBytes[8],
    mystery1: frameBytes[9],
  };
}

/**
 * Encodes one row of palette indices into ZT1 drawing instructions.
 */
function encodeRow(width, indexGrid, rowY) {
  const parts = [];
  let drawingInstructions = [];
  let current = { offset: 0, colors: [] };

  function flushCurrent() {
    if (current.offset !== 0 || current.colors.length > 0) {
      drawingInstructions.push(current);
      current = { offset: 0, colors: [] };
    }
  }

  for (let x = 0; x < width; x++) {
    const idx = indexGrid[rowY * width + x];
    if (idx === 0) {
      if (current.colors.length > 0) {
        flushCurrent();
      }
      current.offset += 1;
      if (current.offset === 255) {
        drawingInstructions.push({ offset: 255, colors: [] });
        current = { offset: 0, colors: [] };
      }
    } else {
      current.colors.push(idx);
      if (current.colors.length === 255) {
        drawingInstructions.push(current);
        current = { offset: 0, colors: [] };
      }
    }
  }
  flushCurrent();

  parts.push(Buffer.from([drawingInstructions.length]));
  for (const instr of drawingInstructions) {
    parts.push(Buffer.from([instr.offset]));
    parts.push(Buffer.from([instr.colors.length]));
    for (const c of instr.colors) {
      parts.push(Buffer.from([c]));
    }
  }
  return Buffer.concat(parts);
}

function buildFrameBuffer(
  width,
  height,
  indexGrid,
  offsetX,
  offsetY,
  mystery0,
  mystery1
) {
  const header = Buffer.concat([
    writeUInt16ZT(height),
    writeUInt16ZT(width),
    writeOffsetPair(offsetY),
    writeOffsetPair(offsetX),
    Buffer.from([mystery0, mystery1]),
  ]);

  const rowChunks = [];
  for (let y = 0; y < height; y++) {
    rowChunks.push(encodeRow(width, indexGrid, y));
  }
  return Buffer.concat([header, ...rowChunks]);
}

// ---------------------------------------------------------------------------
// ZT1 graphic container (ClsGraphic.Write, basic format — no FATZ header)
// ---------------------------------------------------------------------------

function writeGraphicFile(
  filePath,
  animationSpeedMs,
  embeddedPalettePath,
  frameBuffers
) {
  const pathBuf = Buffer.from(embeddedPalettePath, 'latin1');
  const pathWithNull = Buffer.concat([pathBuf, Buffer.from([0])]);
  const pathLengthWithNull = pathWithNull.length;

  const parts = [];
  const speedBuf = Buffer.alloc(4);
  speedBuf.writeUInt32LE(animationSpeedMs, 0);
  parts.push(speedBuf);

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(pathLengthWithNull, 0);
  parts.push(lenBuf);
  parts.push(pathWithNull);

  const frameCountBuf = Buffer.alloc(4);
  frameCountBuf.writeUInt32LE(frameBuffers.length, 0);
  parts.push(frameCountBuf);

  for (const frame of frameBuffers) {
    const flen = Buffer.alloc(4);
    flen.writeUInt32LE(frame.length, 0);
    parts.push(flen);
    parts.push(frame);
  }

  fs.writeFileSync(filePath, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// In-game placement (frame offset X / Y)
//
// The game positions each frame relative to the object footprint centre (see
// ZT Studio: ClsFrame.OffsetX / OffsetY). These are not PNG margins — they are
// the pixel shift the engine applies. Using (0, 0) when the original sprite used
// non-zero values (e.g. 22, 16) makes the art look "offset" or misaligned.
//
// Non-launcher runs: if a reference graphic exists under source/ or source-zt1/
// with the same extensionless name as your output ZT file, frame 0 offsets and
// mystery bytes are copied from it. Otherwise adoption-menu defaults (22, 16) apply.
//
// Launcher runs (GUI): you pick Animation / Adoption / Facts / Other; reference
// offsets are not used for that run.
// ---------------------------------------------------------------------------
// Adoption-menu defaults when no reference graphic exists (non-launcher runs).
const FRAME_OFFSET_X = 22;
const FRAME_OFFSET_Y = 16;
const MYSTERY_BYTE_0 = 0x01;
const MYSTERY_BYTE_1 = 0x00;

const PLACEMENT_PRESETS = {
  '1': { label: 'Animation', offsetX: 93, offsetY: 63 },
  '2': { label: 'Adoption menu', offsetX: 22, offsetY: 16 },
  '3': { label: 'Facts menu', offsetX: 89, offsetY: 97 },
};

function embeddedPalettePathFromSettings(pngToZt1) {
  const folder = normalizeForwardSlashes(pngToZt1.imagePath || DEFAULT_IMAGE_PATH);
  const palFile = normalizePaletteFilename(
    pngToZt1.paletteFilename || DEFAULT_PALETTE_FILENAME
  );
  return `${folder}/${palFile}`;
}

const REFERENCE_GRAPHIC_SUBDIRS = ['source', 'source-zt1'];

/**
 * Looks for a vanilla ZT graphic under source/ or source-zt1/ (same basename as output).
 */
function resolveReferenceGraphicPath(ztBasename) {
  for (const sub of REFERENCE_GRAPHIC_SUBDIRS) {
    const baseDir = path.join(PROJECT_ROOT, sub);
    const candidate = path.join(baseDir, ztBasename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const refBase = path.basename(candidate);
    const sibling =
      refBase === 'n'
        ? path.join(baseDir, 'N')
        : refBase === 'N'
          ? path.join(baseDir, 'n')
          : null;
    if (sibling && fs.existsSync(sibling)) {
      return sibling;
    }
  }
  return null;
}

function parseIntStrict(line, label) {
  const n = Number.parseInt(String(line).trim(), 10);
  if (!Number.isFinite(n)) {
    throw userError(`${label} must be a whole number (no decimals).`);
  }
  return n;
}

function ensureSourcePngFolderExists() {
  const dir = path.join(PROJECT_ROOT, 'source-png');
  if (!fs.existsSync(dir)) {
    throw userError(
      'The source-png folder is missing. Create it in the project folder and put your PNG image inside.'
    );
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw userError(
      'A file named source-png is in the way. It should be a folder that holds your PNG images.'
    );
  }
}

/**
 * Confirms the input PNG exists and can be decoded before asking for ZT settings (launcher)
 * or before building game assets (CLI).
 */
function validateSourcePngReady(sourcePng) {
  if (!fs.existsSync(sourcePng)) {
    throw userError(
      `No PNG found here:\n${sourcePng}\nAdd that file to the source-png folder, or choose another base name.`
    );
  }
  let buf;
  try {
    buf = fs.readFileSync(sourcePng);
  } catch {
    throw userError('The PNG file could not be read. Check that it is not open in another program.');
  }
  try {
    decodePngRgba(buf);
  } catch {
    throw userError(
      'This PNG cannot be used. Export from your editor as 8-bit RGBA PNG (with transparency / alpha).'
    );
  }
}

async function promptPngToZt1Settings(settings) {
  const rl = createRl();
  try {
    const png = settings.pngToZt1 || {};
    const inputBasename = await ask(
      rl,
      'Input PNG base name',
      settings.pngToZt1InputBasename || DEFAULT_PNG_TO_ZT1_INPUT_BASENAME
    );
    if (!isSafeBasename(inputBasename)) {
      throw userError(
        `Invalid input name "${inputBasename}" (use a simple name without slashes or "..").`
      );
    }
    const sourcePngPath = path.join(
      PROJECT_ROOT,
      'source-png',
      `${inputBasename}.png`
    );
    validateSourcePngReady(sourcePngPath);

    const imagePath = await ask(
      rl,
      'Image path (virtual folder inside the ZT graphic, use forward slashes)',
      png.imagePath || DEFAULT_IMAGE_PATH
    );
    if (!imagePath || imagePath.includes('..')) {
      throw userError(
        'Image path must not be empty and must not contain ".." (use forward slashes only).'
      );
    }

    const ztFilename = await ask(
      rl,
      'ZT filename (extensionless output file name in output-zt1/)',
      png.ztFilename || DEFAULT_ZT_FILENAME
    );
    if (!isSafeBasename(ztFilename)) {
      throw userError(
        `Invalid ZT file name "${ztFilename}" (use a simple name without slashes or "..").`
      );
    }

    const paletteFilename = await ask(
      rl,
      'Palette filename (with or without .pal)',
      png.paletteFilename || DEFAULT_PALETTE_FILENAME
    );
    if (!paletteFilename || String(paletteFilename).includes('/') || String(paletteFilename).includes('\\')) {
      throw userError(
        'Palette name must be a single file name (not a path). Example: icflion or icflion.pal'
      );
    }

    console.log('');
    console.log('Frame placement (offset X / Y in the ZT graphic):');
    console.log('  1  Animation        (X=93,  Y=63)');
    console.log('  2  Adoption menu    (X=22,  Y=16)');
    console.log('  3  Facts menu       (X=89,  Y=97)');
    console.log('  4  Other            (enter X and Y manually)');
    const placementChoice = await ask(rl, 'Enter 1-4', '2');
    let offsetX;
    let offsetY;
    if (PLACEMENT_PRESETS[placementChoice]) {
      const p = PLACEMENT_PRESETS[placementChoice];
      offsetX = p.offsetX;
      offsetY = p.offsetY;
      console.log(`Using ${p.label}: offset X=${offsetX}, Y=${offsetY}`);
    } else if (placementChoice === '4') {
      offsetX = parseIntStrict(await ask(rl, 'Offset X', '0'), 'Offset X');
      offsetY = parseIntStrict(await ask(rl, 'Offset Y', '0'), 'Offset Y');
      console.log(`Using custom offsets: X=${offsetX}, Y=${offsetY} (not saved)`);
    } else {
      throw userError('Type 1, 2, 3, or 4 to choose frame placement.');
    }

    saveSettings({
      pngToZt1InputBasename: inputBasename,
      pngToZt1: {
        imagePath: normalizeForwardSlashes(imagePath),
        ztFilename,
        paletteFilename: String(paletteFilename).trim(),
      },
    });

    return {
      inputBasename,
      pngToZt1: {
        imagePath: normalizeForwardSlashes(imagePath),
        ztFilename,
        paletteFilename: String(paletteFilename).trim(),
      },
      launcherOffsets: { offsetX, offsetY },
    };
  } finally {
    rl.close();
  }
}

function resolvePathsAndPlacementFromSettings(settings) {
  const inputBasename =
    settings.pngToZt1InputBasename || DEFAULT_PNG_TO_ZT1_INPUT_BASENAME;
  const png = settings.pngToZt1 || {};
  const pngToZt1 = {
    imagePath: normalizeForwardSlashes(png.imagePath || DEFAULT_IMAGE_PATH),
    ztFilename: (png.ztFilename || DEFAULT_ZT_FILENAME).trim(),
    paletteFilename: png.paletteFilename || DEFAULT_PALETTE_FILENAME,
  };
  const paletteFileOnDisk = normalizePaletteFilename(pngToZt1.paletteFilename);
  const sourcePng = path.join(PROJECT_ROOT, 'source-png', `${inputBasename}.png`);
  const outputPalPath = path.join(OUTPUT_ZT1_DIR, paletteFileOnDisk);
  const outputGraphicPath = path.join(OUTPUT_ZT1_DIR, pngToZt1.ztFilename);
  const embeddedPalettePath = embeddedPalettePathFromSettings(pngToZt1);
  return {
    inputBasename,
    pngToZt1,
    paletteFileOnDisk,
    sourcePng,
    outputPalPath,
    outputGraphicPath,
    embeddedPalettePath,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureSourcePngFolderExists();

  let settings = loadSettings();
  let useLauncherPlacement = false;
  let launcherOffsets = null;

  if (isLauncherMode()) {
    const prompted = await promptPngToZt1Settings(settings);
    settings = loadSettings();
    useLauncherPlacement = true;
    launcherOffsets = prompted.launcherOffsets;
  }

  const paths = resolvePathsAndPlacementFromSettings(settings);
  const { sourcePng, outputPalPath, outputGraphicPath, embeddedPalettePath } =
    paths;

  validateSourcePngReady(sourcePng);

  const pngBytes = fs.readFileSync(sourcePng);
  const { width, height, rgba } = decodePngRgba(pngBytes);

  const colourCompressionRounds = [];
  while (opaqueExceedsPaletteLimit(width, height, rgba)) {
    const merged = mergeClosestPairOfOpaqueColours(
      width,
      height,
      rgba,
      TRANSPARENT_ALPHA_THRESHOLD
    );
    if (!merged) {
      throw userError(
        'This image uses too many solid colours for ZT1 (max 255 besides black). Reduce colours in your art, or merge similar shades in your editor.'
      );
    }
    colourCompressionRounds.push(merged);
  }
  const colourCompressions = colourCompressionRounds.length;

  const { palette, indexGrid } = buildPaletteFromRgba(width, height, rgba);

  fs.mkdirSync(OUTPUT_ZT1_DIR, { recursive: true });
  writePalFile(outputPalPath, palette);

  let frameOffsetX = FRAME_OFFSET_X;
  let frameOffsetY = FRAME_OFFSET_Y;
  let mystery0 = MYSTERY_BYTE_0;
  let mystery1 = MYSTERY_BYTE_1;

  if (useLauncherPlacement && launcherOffsets) {
    frameOffsetX = launcherOffsets.offsetX;
    frameOffsetY = launcherOffsets.offsetY;
    console.log(
      'Placement from launcher choice:',
      `(offsetX=${frameOffsetX}, offsetY=${frameOffsetY}, mystery=${mystery0} ${mystery1})`
    );
  } else {
    const referencePath = resolveReferenceGraphicPath(paths.pngToZt1.ztFilename);

    if (referencePath) {
      const placement = parseFrameHeaderPlacement(
        extractFirstFrameBuffer(fs.readFileSync(referencePath))
      );
      frameOffsetX = placement.offsetX;
      frameOffsetY = placement.offsetY;
      mystery0 = placement.mystery0;
      mystery1 = placement.mystery1;
      console.log(
        'Placement from reference graphic:',
        referencePath,
        `(offsetX=${frameOffsetX}, offsetY=${frameOffsetY}, mystery=${mystery0} ${mystery1})`
      );
      if (placement.refWidth !== width || placement.refHeight !== height) {
        console.log(
          `Note: reference frame size is ${placement.refWidth}×${placement.refHeight}px; ` +
            `your PNG is ${width}×${height}px. Offsets were copied anyway — if alignment ` +
            'still looks wrong, adjust offsets in ZT Studio or by hand.'
        );
      }
    } else {
      console.log(
        `Reference graphic not found for "${paths.pngToZt1.ztFilename}" under source/ or source-zt1/; using default offset X/Y (${FRAME_OFFSET_X}, ${FRAME_OFFSET_Y}).`
      );
    }
  }

  const frameBuffer = buildFrameBuffer(
    width,
    height,
    indexGrid,
    frameOffsetX,
    frameOffsetY,
    mystery0,
    mystery1
  );
  writeGraphicFile(
    outputGraphicPath,
    ANIMATION_SPEED_MS,
    embeddedPalettePath,
    [frameBuffer]
  );

  console.log('');
  console.log('Input PNG:', sourcePng);
  console.log('Dimensions:', `${width}×${height}`);
  console.log('Palette colours:', palette.length);
  console.log('Embedded palette path:', embeddedPalettePath);
  console.log('Wrote:', outputPalPath);
  console.log('Wrote:', outputGraphicPath);

  console.log('');
  console.log(`Completed with ${colourCompressions} colour compressions`);

  if (isLauncherMode() && colourCompressionRounds.length > 0) {
    const rl = createRl();
    try {
      const answer = await ask(
        rl,
        'Generate a Color compression report?',
        'N'
      );
      if (/^y(es)?$/i.test(String(answer).trim())) {
        const reportPath = writeColorCompressionReport(
          PROJECT_ROOT,
          colourCompressionRounds
        );
        console.log('Wrote:', reportPath);
      }
    } finally {
      rl.close();
    }
  }
}

main().catch((err) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
