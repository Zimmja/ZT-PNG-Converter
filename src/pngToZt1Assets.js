const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  mergeClosestPairOfOpaqueColours,
} = require(path.join(__dirname, 'mergeClosestOpaqueColours.js'));

// ---------------------------------------------------------------------------
// CUSTOMIZE: virtual path stored inside the ZT graphic (forward slashes).
// The game resolves this against its asset root; it must end with a .pal name.
//
// Edit the folder and/or filename below. Defaults keep the folder as "testZT".
// ---------------------------------------------------------------------------
const ZT_EMBEDDED_PATH_FOLDER = 'animals/ankylo/plankylo';
const ZT_EMBEDDED_PALETTE_FILENAME = 'plankylo.pal';
const ZT_EMBEDDED_PALETTE_PATH = `${ZT_EMBEDDED_PATH_FOLDER}/${ZT_EMBEDDED_PALETTE_FILENAME}`;

// Project root (parent of src/)
const PROJECT_ROOT = path.join(__dirname, '..');

// Input PNG (relative to project root)
const SOURCE_PNG = path.join(PROJECT_ROOT, 'source-png', 'ankylo-menu.png');

const OUTPUT_ZT1_DIR = path.join(PROJECT_ROOT, 'output-zt1');
const OUTPUT_BASENAME = "n"
const OUTPUT_PAL_PATH = path.join(OUTPUT_ZT1_DIR, `${ZT_EMBEDDED_PALETTE_FILENAME}`);
const OUTPUT_GRAPHIC_PATH = path.join(OUTPUT_ZT1_DIR, OUTPUT_BASENAME);

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
      throw new Error(`Unsupported PNG filter type: ${filterType}`);
    }
    outBuffer[outOffset + x] = raw;
  }
}

function decodePngRgba(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Input is not a PNG file.');
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
    throw new Error('PNG is missing IHDR.');
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error('Only 8-bit RGBA PNGs are supported (color type 6).');
  }

  const bpp = 4;
  const rowByteCount = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const expectedSize = height * (1 + rowByteCount);
  if (inflated.length !== expectedSize) {
    throw new Error(
      `Unexpected decompressed PNG size (got ${inflated.length}, expected ${expectedSize}).`
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
      throw new Error('Internal error: palette grew past 256 entries after validation.');
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
    throw new Error('Reference graphic file is too small.');
  }
  offset += 4;
  const pathLengthWithNull = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  const pathCharCount = pathLengthWithNull - 1;
  if (pathCharCount < 0 || offset + pathLengthWithNull > graphicBuffer.length) {
    throw new Error('Invalid palette path length in reference graphic.');
  }
  offset += pathCharCount;
  if (graphicBuffer[offset] !== 0) {
    throw new Error('Expected null terminator after palette path in reference graphic.');
  }
  offset += 1;

  const frameCount = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  if (frameCount < 1) {
    throw new Error('Reference graphic contains no frames.');
  }
  const frameByteLength = graphicBuffer.readUInt32LE(offset);
  offset += 4;
  if (offset + frameByteLength > graphicBuffer.length) {
    throw new Error('Reference graphic frame length is out of range.');
  }
  return graphicBuffer.subarray(offset, offset + frameByteLength);
}

/**
 * Reads width, height, offset X/Y, and mystery bytes from a frame payload
 * (same interpretation as the decoder / ZT Studio ClsFrame).
 */
function parseFrameHeaderPlacement(frameBytes) {
  if (frameBytes.length < 10) {
    throw new Error('Reference frame is too short.');
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
// Recommended: point REFERENCE_GRAPHIC_FOR_OFFSETS at the vanilla ZT1 graphic
// you are replacing (same art slot). Frame 0's offsets and mystery bytes are
// copied automatically.
//
// Set to null to skip copying and use FRAME_OFFSET_X / FRAME_OFFSET_Y /
// MYSTERY_* only (e.g. when tuning placement by hand).
// ---------------------------------------------------------------------------
const REFERENCE_GRAPHIC_FOR_OFFSETS = path.join(PROJECT_ROOT, 'source', 'n');

// Confirmed correct placement for this sprite (used when no reference graphic is found).
const FRAME_OFFSET_X = 22;
const FRAME_OFFSET_Y = 16;
const MYSTERY_BYTE_0 = 0x01;
const MYSTERY_BYTE_1 = 0x00;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(SOURCE_PNG)) {
    throw new Error(`Missing input PNG: ${SOURCE_PNG}`);
  }

  const pngBytes = fs.readFileSync(SOURCE_PNG);
  const { width, height, rgba } = decodePngRgba(pngBytes);

  let colourCompressions = 0;
  while (opaqueExceedsPaletteLimit(width, height, rgba)) {
    const merged = mergeClosestPairOfOpaqueColours(
      width,
      height,
      rgba,
      TRANSPARENT_ALPHA_THRESHOLD
    );
    if (!merged) {
      const n = countDistinctOpaqueRgb(width, height, rgba).size
      throw new Error(
        'Opaque colour count still exceeds the ZT1 palette limit but fewer than two distinct opaque colours exist to merge.'
      );
    }
    colourCompressions += 1;
  }

  const { palette, indexGrid } = buildPaletteFromRgba(width, height, rgba);

  fs.mkdirSync(OUTPUT_ZT1_DIR, { recursive: true });
  writePalFile(OUTPUT_PAL_PATH, palette);

  let frameOffsetX = FRAME_OFFSET_X;
  let frameOffsetY = FRAME_OFFSET_Y;
  let mystery0 = MYSTERY_BYTE_0;
  let mystery1 = MYSTERY_BYTE_1;

  if (REFERENCE_GRAPHIC_FOR_OFFSETS != null) {
    let referencePath = null;
    if (fs.existsSync(REFERENCE_GRAPHIC_FOR_OFFSETS)) {
      referencePath = REFERENCE_GRAPHIC_FOR_OFFSETS;
    } else {
      const refDir = path.dirname(REFERENCE_GRAPHIC_FOR_OFFSETS);
      const refBase = path.basename(REFERENCE_GRAPHIC_FOR_OFFSETS);
      const sibling =
        refBase === 'n'
          ? path.join(refDir, 'N')
          : refBase === 'N'
            ? path.join(refDir, 'n')
            : null;
      if (sibling && fs.existsSync(sibling)) {
        referencePath = sibling;
      }
    }

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
            'still looks wrong, adjust FRAME_OFFSET_X/Y in ZT Studio or by hand.'
        );
      }
    } else {
      console.log(
        `Reference graphic not found (${REFERENCE_GRAPHIC_FOR_OFFSETS}); using FRAME_OFFSET_X/Y.`
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
    OUTPUT_GRAPHIC_PATH,
    ANIMATION_SPEED_MS,
    ZT_EMBEDDED_PALETTE_PATH,
    [frameBuffer]
  );

  console.log('Input PNG:', SOURCE_PNG);
  console.log('Dimensions:', `${width}×${height}`);
  console.log('Palette colours:', palette.length);
  console.log('Embedded palette path (customize at top of file):', ZT_EMBEDDED_PALETTE_PATH);
  console.log('Wrote:', OUTPUT_PAL_PATH);
  console.log('Wrote:', OUTPUT_GRAPHIC_PATH);
  console.log(`Completed with ${colourCompressions} colour compressions`);
}

main();
