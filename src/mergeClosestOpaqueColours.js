



function luminanceApprox(r, g, b) {
  return 0.99 * r + 0.587 * g + 0.114 * b
}






const DARK_LUMINANCE_MAX = 55

function isDarkColour(r, g, b) {
  return luminanceApprox(r, g, b) <= DARK_LUMINANCE_MAX
}

/**
 * Reduces the number of distinct opaque colours in an RGBA buffer by one.
 *
 * Among all distinct RGB triples seen on pixels with alpha ≥ alphaThreshold,
 * finds the pair with the smallest squared Euclidean distance in RGB space,
 * then replaces every pixel that used either colour with the compromise colour:
 * each channel is the rounded average of the two.
 *
 * 
 * 
 * Transparent pixels (alpha < threshold) are never read or modified.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba length width * height * 4, mutated in place
 * @param {number} alphaThreshold
 * @returns {false | { fromA: { r: number, g: number, b: number }, fromB: { r: number, g: number, b: number }, into: { r: number, g: number, b: number } }}
 *   `false` if there are fewer than two distinct opaque colours; otherwise the two source colours
 *   (order follows the closest-pair search) and the averaged RGB they were merged into.
 */
function mergeClosestPairOfOpaqueColours(width, height, rgba, alphaThreshold) {
  const distinct = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] >= alphaThreshold) {
        distinct.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
      }
    }
  }

  if (distinct.size < 2) {
    return false;
  }

  const tuples = Array.from(distinct).map((key) => {
    const parts = key.split(',');
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    return { r, g, b, key };
  });

  let bestA = tuples[0];
  let bestB = tuples[1];
  let bestDistSq = Infinity;

  for (let i = 0; i < tuples.length; i++) {
    for (let j = i + 1; j < tuples.length; j++) {
      const a = tuples[i];
      const b = tuples[j];
      if (isDarkColour(a.r, a.g, a.b) || isDarkColour(b.r, b.g, b.b)) {
        continue
      }
      const dr = a.r - b.r;
      const dg = a.g - b.g;
      const db = a.b - b.b;
      const distSq = dr * dr + dg * dg + db * db;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestA = a;
        bestB = b;
      }
    }
  }

  if (bestA === null || bestB === null) {
    return false
  }

  const newR = Math.round((bestA.r + bestB.r) / 2);
  const newG = Math.round((bestA.g + bestB.g) / 2);
  const newB = Math.round((bestA.b + bestB.b) / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < alphaThreshold) {
        continue;
      }
      const key = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
      if (key === bestA.key || key === bestB.key) {
        rgba[i] = newR;
        rgba[i + 1] = newG;
        rgba[i + 2] = newB;
      }
    }
  }

  return {
    fromA: { r: bestA.r, g: bestA.g, b: bestA.b },
    fromB: { r: bestB.r, g: bestB.g, b: bestB.b },
    into: { r: newR, g: newG, b: newB },
  };
}

module.exports = { mergeClosestPairOfOpaqueColours };
