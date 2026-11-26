/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, Versions 1–16, EC Level L / M)
 * generating compact SVG markup for desktop Relay pairing without external non-JS dependencies.
 */

export type QrErrorCorrection = "L" | "M";

interface BlockSpec {
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
}

const ALIGNMENT_POSITIONS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
];

// Index 1..16 maps to QR Version 1..16
const EC_SPECS: Record<QrErrorCorrection, BlockSpec[]> = {
  L: [
    { ecPerBlock: 0, g1Blocks: 0, g1Data: 0, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69 },
    { ecPerBlock: 20, g1Blocks: 4, g1Data: 81, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 24, g1Blocks: 2, g1Data: 92, g2Blocks: 2, g2Data: 93 },
    { ecPerBlock: 26, g1Blocks: 4, g1Data: 107, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 30, g1Blocks: 3, g1Data: 115, g2Blocks: 1, g2Data: 116 },
    { ecPerBlock: 22, g1Blocks: 5, g1Data: 87, g2Blocks: 1, g2Data: 88 },
    { ecPerBlock: 24, g1Blocks: 5, g1Data: 98, g2Blocks: 1, g2Data: 99 },
  ],
  M: [
    { ecPerBlock: 0, g1Blocks: 0, g1Data: 0, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0 },
    { ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39 },
    { ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37 },
    { ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44 },
    { ecPerBlock: 30, g1Blocks: 1, g1Data: 50, g2Blocks: 4, g2Data: 51 },
    { ecPerBlock: 22, g1Blocks: 6, g1Data: 36, g2Blocks: 2, g2Data: 37 },
    { ecPerBlock: 22, g1Blocks: 8, g1Data: 37, g2Blocks: 1, g2Data: 38 },
    { ecPerBlock: 24, g1Blocks: 4, g1Data: 40, g2Blocks: 5, g2Data: 41 },
    { ecPerBlock: 24, g1Blocks: 5, g1Data: 41, g2Blocks: 5, g2Data: 42 },
    { ecPerBlock: 28, g1Blocks: 7, g1Data: 45, g2Blocks: 3, g2Data: 46 },
  ],
};

// GF(256) lookup tables with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = buildRsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(String(text || ""));
}

function totalDataCodewords(spec: BlockSpec): number {
  return spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
}

function selectVersion(byteLen: number, ecLevel: QrErrorCorrection): number {
  const specs = EC_SPECS[ecLevel];
  for (let v = 1; v < specs.length; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLen * 8;
    const capBits = totalDataCodewords(specs[v]) * 8;
    if (neededBits <= capBits) return v;
  }
  throw new Error(`QR payload too large (${byteLen} bytes)`);
}

function encodeCodewords(bytes: Uint8Array, version: number, ecLevel: QrErrorCorrection): Uint8Array {
  const spec = EC_SPECS[ecLevel][version];
  const dataCap = totalDataCodewords(spec);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode: Byte (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = dataCap * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(dataCap);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    dataBytes[byteIdx++] = val;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (byteIdx < dataCap) {
    dataBytes[byteIdx++] = padBytes[padIdx % 2];
    padIdx++;
  }

  // Split into blocks & compute RS error correction codewords
  const blocks: Array<{ data: Uint8Array; ec: Uint8Array }> = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i++) {
    const slice = dataBytes.subarray(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    blocks.push({ data: slice, ec: computeRsRemainder(slice, spec.ecPerBlock) });
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const slice = dataBytes.subarray(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    blocks.push({ data: slice, ec: computeRsRemainder(slice, spec.ecPerBlock) });
  }

  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  const out: number[] = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.data.length) out.push(blk.data[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of blocks) {
      out.push(blk.ec[i]);
    }
  }
  return new Uint8Array(out);
}

function computeFormatBits(ecLevel: QrErrorCorrection, mask: number): number {
  // L = 01, M = 00
  const ecBits = ecLevel === "M" ? 0b00 : 0b01;
  const data = (ecBits << 3) | (mask & 0x7);
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((rem >>> (i + 10)) & 1) {
      rem ^= 0x537 << i;
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((rem >>> (i + 12)) & 1) {
      rem ^= 0x1f25 << i;
    }
  }
  return (version << 12) | rem;
}

function createEmptyGrid(size: number) {
  const modules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const setFixed = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    reserved[r][c] = true;
  };

  const placeFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const isDark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFixed(r, c, isDark);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  return { modules, reserved, setFixed };
}

function placeAlignmentPatterns(
  version: number,
  size: number,
  setFixed: (r: number, c: number, dark: boolean) => void
) {
  const centers = ALIGNMENT_POSITIONS[version] || [];
  for (const r0 of centers) {
    for (const c0 of centers) {
      // Skip only the 3 corners overlapping finder patterns (never skip timing-pattern row/col 6!)
      const overlapsFinder =
        (r0 <= 8 && c0 <= 8) ||
        (r0 <= 8 && c0 >= size - 9) ||
        (r0 >= size - 9 && c0 <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFixed(r0 + dr, c0 + dc, isDark);
        }
      }
    }
  }
}

function reserveFormatAndVersionAreas(version: number, size: number, setFixed: (r: number, c: number, dark: boolean) => void) {
  // Format information around top-left, top-right, bottom-left finders + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFixed(8, i, false);
      setFixed(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFixed(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i++) {
    setFixed(size - 1 - i, 8, false);
  }
  setFixed(size - 8, 8, true);

  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFixed(r, c, bit);
      setFixed(c, r, bit);
    }
  }
}

function applyFormatBits(ecLevel: QrErrorCorrection, mask: number, modules: boolean[][]) {
  const size = modules.length;
  const bits = computeFormatBits(ecLevel, mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    // Vertical left + top-right horizontal
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    if (i < 8) modules[8][size - 1 - i] = dark;
    else if (i < 9) modules[8][7] = dark;
    else modules[8][14 - i] = dark;
  }
  modules[size - 8][8] = true;
}

function maskMatches(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function computePenalty(modules: boolean[][]): number {
  const n = modules.length;
  let penalty = 0;

  // Rule 1: 5+ same-color run in row / col
  for (let r = 0; r < n; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < n; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 same-color blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const m = modules[r][c];
      if (m === modules[r][c + 1] && m === modules[r + 1][c] && m === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 4: dark ratio balance
  let darkCount = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) darkCount++;
    }
  }
  const percent = (darkCount * 100) / (n * n);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  penalty += k * 10;
  return penalty;
}

export function encodeQrMatrix(text: string, ecLevel: QrErrorCorrection = "L"): boolean[][] {
  const bytes = utf8Bytes(text);
  const version = selectVersion(bytes.length, ecLevel);
  const codewords = encodeCodewords(bytes, version, ecLevel);
  const size = version * 4 + 17;

  const base = createEmptyGrid(size);
  placeAlignmentPatterns(version, size, base.setFixed);
  reserveFormatAndVersionAreas(version, size, base.setFixed);

  // Place interleaved codewords into zig-zag data positions
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = right - dc;
        if (base.reserved[r][c]) continue;
        let bit = false;
        if (bitIdx < totalBits) {
          const byteVal = codewords[bitIdx >>> 3];
          bit = ((byteVal >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        base.modules[r][c] = bit;
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestGrid = base.modules;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.modules.map((row, r) =>
      row.map((val, c) => (base.reserved[r][c] ? val : val !== maskMatches(mask, r, c)))
    );
    applyFormatBits(ecLevel, mask, candidate);
    const p = computePenalty(candidate);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestGrid = candidate;
    }
  }

  void bestMask;
  return bestGrid;
}

export function renderQrSvg(
  text: string,
  {
    size = 220,
    margin = 4,
    ecLevel = "L" as QrErrorCorrection,
    darkColor = "#000000",
    lightColor = "#ffffff",
  }: {
    size?: number;
    margin?: number;
    ecLevel?: QrErrorCorrection;
    darkColor?: string;
    lightColor?: string;
  } = {}
): string {
  const matrix = encodeQrMatrix(text, ecLevel);
  const n = matrix.length;
  const viewSize = n + margin * 2;
  const paths: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }
  const px = Math.max(80, Math.min(512, Math.round(size)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" ` +
    `width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR Code">` +
    `<rect width="${viewSize}" height="${viewSize}" fill="${lightColor}"/>` +
    `<path d="${paths.join("")}" fill="${darkColor}"/>` +
    `</svg>`
  );
}
