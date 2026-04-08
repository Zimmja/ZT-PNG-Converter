const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
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
    throw new Error('RGBA buffer size does not match width and height.');
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

/**
 * Each round: column 0 and 1 = colours merged, column 2 = result colour.
 *
 * @param {Array<{ fromA: { r: number, g: number, b: number }, fromB: { r: number, g: number, b: number }, into: { r: number, g: number, b: number } }>} rounds
 * @returns {Buffer} PNG file bytes
 */
function buildColorCompressionReportPng(rounds) {
  const width = 3;
  const height = rounds.length;
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const round = rounds[y];
    const pixels = [round.fromA, round.fromB, round.into];
    for (let x = 0; x < 3; x++) {
      const c = pixels[x];
      const i = (y * width + x) * 4;
      rgba[i] = c.r;
      rgba[i + 1] = c.g;
      rgba[i + 2] = c.b;
      rgba[i + 3] = 255;
    }
  }

  return encodePngRgba(width, height, rgba);
}

/**
 * @param {string} projectRoot
 * @param {Array<{ fromA: object, fromB: object, into: object }>} rounds
 * @returns {string} absolute path written
 */
function writeColorCompressionReport(projectRoot, rounds) {
  const reportsDir = path.join(projectRoot, 'reports');
  const datePart = new Date().toISOString().slice(0, 10);

  fs.mkdirSync(reportsDir, { recursive: true });

  let filePath;
  do {
    const randomSuffix = crypto.randomInt(100_000, 1_000_000);
    filePath = path.join(reportsDir, `CCR_${datePart}_${randomSuffix}.png`);
  } while (fs.existsSync(filePath));

  const png = buildColorCompressionReportPng(rounds);
  fs.writeFileSync(filePath, png);
  return filePath;
}

module.exports = {
  buildColorCompressionReportPng,
  writeColorCompressionReport,
};
