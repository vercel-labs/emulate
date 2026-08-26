import { encodeQrMatrix } from "./qr.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ponytail: uncompressed deflate (stored blocks); PNG stays tiny at QR sizes
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1);
  }

  const numBlocks = Math.ceil(raw.length / 65535);
  const idat = new Uint8Array(2 + raw.length + numBlocks * 5 + 4);
  const view = new DataView(idat.buffer);
  idat[0] = 0x78;
  idat[1] = 0x01;
  let off = 2;
  for (let i = 0; i < numBlocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    const last = i === numBlocks - 1 ? 1 : 0;
    idat[off] = last;
    view.setUint16(off + 1, len, true);
    view.setUint16(off + 3, ~len & 0xffff, true);
    idat.set(raw.subarray(start, start + len), off + 5);
    off += 5 + len;
  }
  view.setUint32(off, adler32(raw));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const png = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    png.set(part, pos);
    pos += part.length;
  }
  return png;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function renderQrPng(text: string, scale = 8, quietZone = 4): Uint8Array {
  const modules = encodeQrMatrix(text);
  const size = modules.length + quietZone * 2;
  const dim = size * scale;
  const pixels = new Uint8Array(dim * dim).fill(255);
  for (let my = 0; my < modules.length; my++) {
    for (let mx = 0; mx < modules.length; mx++) {
      if (!modules[my][mx]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((my + quietZone) * scale + dy) * dim + (mx + quietZone) * scale;
        pixels.fill(0, row, row + scale);
      }
    }
  }
  return encodePng(dim, dim, pixels);
}
