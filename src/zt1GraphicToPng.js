/**
 * Decodes a Zoo Tycoon 1-style extensionless graphic plus its .pal palette
 * and writes a PNG (first animation frame) to the path given in Config.txt (pngOutputPath).
 * The file name part can be overridden with --output-basename (same folder as in config).
 *
 * Format reference: jbostoen/ZTStudio (ClsGraphic.vb, ClsFrame.vb, clsPalette.vb).
 *
 * Run with Node: node src/zt1GraphicToPng.js (from project root)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { isSafeBasename } = require(path.join(
  __dirname,
  'converterLocalSettings.js'
));
const {
  loadAndValidateForZt1ToPng,
} = require(path.join(__dirname, 'converterConfig.js'));
const { userError, formatCliError } = require(path.join(__dirname, 'cliError.js'));

// ---------------------------------------------------------------------------
// Paths (project root = parent of src/)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');

function parseOutputBasenameFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--output-basename=')) {
      return a.slice('--output-basename='.length);
    }
    if (a === '--output-basename' && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return null;
}

/**
 * @param {{ outputDir: string, basenameNoExt: string, outputPngAbs: string }} pngOutputParsed
 */
function resolveOutputPngPath(pngOutputParsed) {
  const fromArgv = parseOutputBasenameFromArgv(process.argv.slice(2));
  if (fromArgv !== null && fromArgv !== '') {
    if (!isSafeBasename(fromArgv)) {
      throw userError(
        `Invalid output name "${fromArgv}" (use a simple name without path separators).`
      );
    }
    return path.join(pngOutputParsed.outputDir, `${fromArgv.trim()}.png`);
  }
  return pngOutputParsed.outputPngAbs;
}

// ---------------------------------------------------------------------------
// Little-endian reads
// ---------------------------------------------------------------------------

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readUInt16BEFromBytes(low, high) {
  return (high << 8) | low;
}

// ---------------------------------------------------------------------------
// .pal (ZT1 palette)
// First 4 bytes: header (colour count is in first uint16 LE, typically 256).
// Then repeating RGBA: R, G, B, A. Index 0 is always rendered as opaque black.
// ---------------------------------------------------------------------------

function loadPalette(palPath) {
  const raw = fs.readFileSync(palPath);
  if (raw.length < 4) {
    throw userError(
      'The palette file looks empty or incomplete. Check that it is a valid ZT1 .pal file.'
    );
  }

  const colours = [];
  let offset = 4;

  while (offset + 4 <= raw.length) {
    const r = raw[offset];
    const g = raw[offset + 1];
    const b = raw[offset + 2];
    const a = raw[offset + 3];
    colours.push({ r, g, b, a });
    offset += 4;
  }

  if (colours.length === 0) {
    throw userError(
      'The palette file does not contain any colours. It may be damaged or the wrong file.'
    );
  }

  return colours;
}

/**
 * Palette index 0 is always drawn as opaque black (ignores RGB/A in the .pal file).
 */
function paletteColourToRgba(palette, index) {
  if (index === 0) {
    return { r: 0, g: 0, b: 0, a: 255 };
  }
  const c = palette[index] || { r: 0, g: 0, b: 0, a: 255 };
  return {
    r: c.r,
    g: c.g,
    b: c.b,
    a: c.a === 0 ? 255 : c.a,
  };
}

// ---------------------------------------------------------------------------
// Extensionless graphic (ClsGraphic.Read)
// ---------------------------------------------------------------------------

/**
 * @param {string} zt1SourceDirAbs
 */
function findGraphicPath(zt1SourceDirAbs) {
  const candidates = [
    path.join(zt1SourceDirAbs, 'N'),
    path.join(zt1SourceDirAbs, 'n'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const label = path.relative(PROJECT_ROOT, zt1SourceDirAbs) || zt1SourceDirAbs;
  throw userError(
    `Add a ZT1 graphic file to your ZT1 source folder (${label}). It should be named N or n and have no file extension.`
  );
}

/**
 * Reads the ZT1 graphic container. Returns palette relative path string from
 * the file and an array of frame buffers (raw frame byte payloads only).
 */
function parseGraphicFile(graphicPath) {
  const buffer = fs.readFileSync(graphicPath);
  let offset = 0;

  if (buffer.length < 12) {
    throw userError('The graphic file is too small to be a valid ZT1 file.');
  }

  // Optional FATZ (ZT animation) header: "FATZ" + padding + background flag
  if (
    buffer[0] === 0x46 &&
    buffer[1] === 0x41 &&
    buffer[2] === 0x54 &&
    buffer[3] === 0x5a
  ) {
    offset = 9;
  }

  const animationSpeedMs = readUInt32LE(buffer, offset);
  offset += 4;

  const palettePathLengthWithNull = readUInt32LE(buffer, offset);
  offset += 4;

  const palettePathCharCount = palettePathLengthWithNull - 1;
  const paletteRelativePath = buffer
    .subarray(offset, offset + palettePathCharCount)
    .toString('latin1');
  offset += palettePathCharCount;
  // Skip null terminator
  if (buffer[offset] !== 0) {
    throw userError(
      'The graphic file looks damaged (palette path is not in the expected format).'
    );
  }
  offset += 1;

  const frameCount = readUInt32LE(buffer, offset);
  offset += 4;

  const frames = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    if (offset + 4 > buffer.length) {
      throw userError(
        'The graphic file ends unexpectedly while reading frame data. The file may be incomplete.'
      );
    }
    const frameByteLength = readUInt32LE(buffer, offset);
    offset += 4;
    if (offset + frameByteLength > buffer.length) {
      throw userError(
        'The graphic file ends unexpectedly inside a frame. The file may be incomplete or damaged.'
      );
    }
    frames.push(buffer.subarray(offset, offset + frameByteLength));
    offset += frameByteLength;
  }

  return {
    animationSpeedMs,
    paletteRelativePath,
    frameCount,
    frames,
  };
}

function resolvePalettePath(graphicPath, paletteRelativePath, zt1SourceDirAbs) {
  const baseName = path.basename(paletteRelativePath.replace(/\\/g, '/'));
  const nextToGraphic = path.join(path.dirname(graphicPath), baseName);
  if (fs.existsSync(nextToGraphic)) {
    return nextToGraphic;
  }
  const inSource = path.join(zt1SourceDirAbs, baseName);
  if (fs.existsSync(inSource)) {
    return inSource;
  }
  const label = path.relative(PROJECT_ROOT, zt1SourceDirAbs) || zt1SourceDirAbs;
  throw userError(
    `Could not find the palette file "${baseName}". Put it in ${label} next to the graphic (or in the same folder as the graphic on disk).`
  );
}

// ---------------------------------------------------------------------------
// Frame decode (ClsFrame.RenderCoreImageFromHex — regular format)
// ---------------------------------------------------------------------------

function decodeFrame(frameBytes, palette) {
  if (frameBytes.length < 10) {
    throw userError(
      'The image frame in this graphic is too small to read. The file may be damaged.'
    );
  }

  const byte0 = frameBytes[0];
  const byte1 = frameBytes[1];

  // 10-byte "empty" frame shortcut (e.g. some restaurant views)
  if (frameBytes.length === 10) {
    if (
      byte0 === 0 &&
      byte1 === 0 &&
      frameBytes[2] === 0 &&
      frameBytes[3] === 0
    ) {
      return {
        width: 1,
        height: 1,
        rgba: Buffer.from([0, 0, 0, 0]),
      };
    }
    throw userError(
      'This graphic uses a frame layout this tool does not support yet.'
    );
  }

  // Marine Mania compressed shadow format (not used by our sample)
  if (byte1 === 0x80) {
    throw userError(
      'This graphic uses a compressed shadow format that this tool does not support yet.'
    );
  }

  const height = readUInt16BEFromBytes(frameBytes[0], frameBytes[1]);
  const width = readUInt16BEFromBytes(frameBytes[2], frameBytes[3]);

  let offsetY;
  if (frameBytes[5] === 0xff) {
    offsetY = ((256 * 256) - readUInt16BEFromBytes(frameBytes[4], frameBytes[5])) * -1;
  } else {
    offsetY = readUInt16BEFromBytes(frameBytes[4], frameBytes[5]);
    if (offsetY >= 0x8000) {
      offsetY -= 0x10000;
    }
  }

  let offsetX;
  if (frameBytes[7] === 0xff) {
    offsetX = ((256 * 256) - readUInt16BEFromBytes(frameBytes[6], frameBytes[7])) * -1;
  } else {
    offsetX = readUInt16BEFromBytes(frameBytes[6], frameBytes[7]);
    if (offsetX >= 0x8000) {
      offsetX -= 0x10000;
    }
  }

  // mystery bytes at 8–9 are ignored for rendering (same as ZT Studio)

  let pos = 10;
  const rowStride = width * 4;
  const rgba = Buffer.alloc(width * height * 4, 0);

  let drawY = 0;

  while (pos < frameBytes.length && drawY < height) {
    const numRowInstructions = frameBytes[pos];
    pos += 1;

    let drawX = 0;

    for (let instr = 0; instr < numRowInstructions; instr++) {
      if (pos + 2 > frameBytes.length) {
        throw userError(
          'The frame data ends unexpectedly while reading a row. The graphic may be damaged.'
        );
      }
      const skipTransparent = frameBytes[pos];
      const numColourPixels = frameBytes[pos + 1];
      pos += 2;

      drawX += skipTransparent;

      if (pos + numColourPixels > frameBytes.length) {
        throw userError(
          'The frame data ends unexpectedly while reading colours. The graphic may be damaged.'
        );
      }

      for (let p = 0; p < numColourPixels; p++) {
        const paletteIndex = frameBytes[pos + p];
        const c = paletteColourToRgba(palette, paletteIndex);
        const pixelOffset = drawY * rowStride + drawX * 4;
        rgba[pixelOffset] = c.r;
        rgba[pixelOffset + 1] = c.g;
        rgba[pixelOffset + 2] = c.b;
        rgba[pixelOffset + 3] = c.a;
        drawX += 1;
      }
      pos += numColourPixels;
    }

    drawY += 1;
  }

  return {
    width,
    height,
    offsetX,
    offsetY,
    rgba,
  };
}

// ---------------------------------------------------------------------------
// Minimal PNG writer (RGBA8, no external packages)
// ---------------------------------------------------------------------------

const CRC_TABLE = (function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePngRgba(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw userError('Internal error while building the PNG. Try running the conversion again.');
  }

  const rawRows = [];
  const rowLength = 1 + width * 4;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowLength);
    row[0] = 0;
    rgba.copy(row, 1, y * width * 4, (y + 1) * width * 4);
    rawRows.push(row);
  }
  const rawImage = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawImage, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Confirms the configured ZT1 source folder has a readable graphic, resolvable palette, and loadable colours
 * before writing the output PNG.
 * @param {string} zt1SourceDirAbs
 */
function loadZt1SourceBundle(zt1SourceDirAbs) {
  const sourceLabel =
    path.relative(PROJECT_ROOT, zt1SourceDirAbs) || zt1SourceDirAbs;
  if (!fs.existsSync(zt1SourceDirAbs)) {
    throw userError(
      `The ZT1 source folder is missing (${sourceLabel}). Create it and add your ZT1 graphic (named N or n, no extension) and its palette (.pal) file.`
    );
  }
  if (!fs.statSync(zt1SourceDirAbs).isDirectory()) {
    throw userError(
      `ZT1 source path must be a folder (${sourceLabel}). Check zt1SourceDirPath in Config.txt.`
    );
  }
  const graphicPath = findGraphicPath(zt1SourceDirAbs);
  const graphic = parseGraphicFile(graphicPath);
  if (graphic.frames.length === 0) {
    throw userError('The ZT1 graphic does not contain any frames to export.');
  }
  const palettePath = resolvePalettePath(
    graphicPath,
    graphic.paletteRelativePath,
    zt1SourceDirAbs
  );
  const palette = loadPalette(palettePath);
  return { graphicPath, graphic, palettePath, palette };
}

async function main() {
  const { zt1SourceDirAbs, pngOutputParsed } = loadAndValidateForZt1ToPng();
  const outputPng = resolveOutputPngPath(pngOutputParsed);

  const { graphicPath, graphic, palettePath, palette } =
    loadZt1SourceBundle(zt1SourceDirAbs);

  let firstFrame;
  try {
    firstFrame = decodeFrame(graphic.frames[0], palette);
  } catch (err) {
    if (err && err.message && err.message.startsWith('ERROR:')) {
      throw err;
    }
    throw userError(
      'The first frame of this graphic could not be turned into an image. The file may use an unsupported format.'
    );
  }
  const pngBuffer = encodePngRgba(firstFrame.width, firstFrame.height, firstFrame.rgba);

  fs.mkdirSync(path.dirname(outputPng), { recursive: true });
  fs.writeFileSync(outputPng, pngBuffer);

  console.log('Graphic:', graphicPath);
  console.log('Palette:', palettePath);
  console.log('Animation speed (ms):', graphic.animationSpeedMs);
  console.log('Frame count:', graphic.frames.length);
  console.log(
    'First frame:',
    `${firstFrame.width}×${firstFrame.height}px`,
    `(offsets X=${firstFrame.offsetX}, Y=${firstFrame.offsetY} — informational only)`
  );
  console.log('Wrote:', outputPng);
}

main().catch((err) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
