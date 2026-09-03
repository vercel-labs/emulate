const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19];
// ponytail: versions capped at 20 (byte-mode M capacity ~650 chars); extend table if ever needed
const ALIGNMENT_POSITIONS: number[][] = [
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
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver: number): number {
  return (
    Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK_M[ver] * NUM_ERROR_CORRECTION_BLOCKS_M[ver]
  );
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = (b ^ (result.shift() as number)) & 0xff;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= reedSolomonMultiply(divisor[i], factor);
  }
  return result;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const dataBytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  while (version <= 20) {
    const charCountBits = version < 10 ? 8 : 16;
    if (getNumDataCodewords(version) * 8 >= dataBytes.length * 8 + 4 + charCountBits) break;
    version++;
  }
  if (version > 20) throw new Error("QR payload too long");

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunctionModule = (x: number, y: number, isDark: boolean): void => {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  };

  const drawFinderPattern = (x: number, y: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);

  const align = ALIGNMENT_POSITIONS[version - 1];
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(align[j] + dx, align[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  for (let i = 0; i < size; i++) {
    if (!isFunction[6][i]) setFunctionModule(i, 6, i % 2 === 0);
    if (!isFunction[i][6]) setFunctionModule(6, i, i % 2 === 0);
  }

  const drawFormatBits = (): void => {
    const formatData = (0 << 3) | 0; // ECC level M, mask 0
    let rem = formatData;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((formatData << 10) | rem) ^ 0x5412;
    const getBit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i));
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(bits, i));
    setFunctionModule(size - 8, 8, true);
  };
  drawFormatBits();

  if (version >= 7) {
    let vrem = version;
    for (let i = 0; i < 12; i++) vrem = (vrem << 1) ^ ((vrem >>> 11) & 1 ? 0x1f25 : 0);
    const bits = (version << 12) | vrem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      setFunctionModule(Math.floor(i / 3), (i % 3) + size - 11, bit);
      setFunctionModule((i % 3) + size - 11, Math.floor(i / 3), bit);
    }
  }

  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK_M[version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const bitBuf: number[] = [];
  const appendBits = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bitBuf.push((val >>> i) & 1);
  };
  appendBits(0x4, 4); // byte mode
  appendBits(dataBytes.length, version < 10 ? 8 : 16);
  for (const b of dataBytes) appendBits(b, 8);
  appendBits(0, Math.min(4, getNumDataCodewords(version) * 8 - bitBuf.length));
  appendBits(0, (8 - (bitBuf.length % 8)) % 8);
  for (let padByte = 0xec; bitBuf.length < getNumDataCodewords(version) * 8; padByte ^= 0xec ^ 0x11)
    appendBits(padByte, 8);

  const dataCodewords: number[] = [];
  for (let i = 0; i < bitBuf.length; i += 8)
    dataCodewords.push(bitBuf.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  const generator = reedSolomonComputeDivisor(eccLen);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const block = dataCodewords.slice(k, k + dataLen);
    k += dataLen;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonComputeRemainder(block, generator));
  }

  const codewords: number[] = [];
  const maxDataLen = shortBlockLen - eccLen + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < dataBlocks[j].length) codewords.push(dataBlocks[j][i]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let j = 0; j < numBlocks; j++) codewords.push(eccBlocks[j][i]);
  }

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
    }
  }

  return modules;
}
