import { crc32, deflateSync } from "node:zlib";

/** An 8-bit RGBA color. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Image formats the emulator can render without fixtures. */
export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "svg";

/** Media types for each rendered image format. */
export const IMAGE_MEDIA_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/** A stable FNV-1a hash used to derive colors and ids from request text. */
export function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

/** A deterministic opaque color for a seed string. */
export function colorFor(seed: string): Rgba {
  const hash = hash32(seed);
  return { r: hash & 0xff, g: (hash >>> 8) & 0xff, b: (hash >>> 16) & 0xff, a: 255 };
}

/** Renders a solid image of the given size in a real, decodable file format. */
export function renderImage(format: ImageFormat, width: number, height: number, color: Rgba): Uint8Array {
  switch (format) {
    case "png":
      return encodePng(width, height, color);
    case "jpeg":
      return encodeJpeg(width, height, color);
    case "webp":
      return encodeWebp(width, height, color);
    case "gif":
      return encodeGif(width, height, color);
    case "svg":
      return encodeSvg(width, height, color);
  }
}

/** Detects an image media type from its leading bytes. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  const head = ascii(bytes, 0, Math.min(bytes.length, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

/** Reads width and height from a PNG, JPEG, WebP, or GIF header. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = sniffImageType(bytes);
  if (type === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (type === "image/gif" && bytes.length >= 10)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (type === "image/webp" && ascii(bytes, 12, 16) === "VP8L" && bytes.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === "image/jpeg") {
    let at = 2;
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xc3) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

function encodePng(width: number, height: number, color: Rgba): Uint8Array {
  const alpha = color.a < 255;
  const channels = alpha ? 4 : 3;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const row = new Uint8Array(1 + width * channels);
  for (let x = 0; x < width; x += 1) {
    row.set(alpha ? [color.r, color.g, color.b, color.a] : [color.r, color.g, color.b], 1 + x * channels);
  }
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** Writes bits most significant first, as JPEG entropy coding requires, stuffing a zero after every 0xFF byte. */
class MsbBitWriter {
  private bytes: number[] = [];
  private current = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.current = (this.current << 1) | ((value >>> bit) & 1);
      this.count += 1;
      if (this.count === 8) this.flushByte();
    }
  }

  finish(): Uint8Array {
    if (this.count > 0) this.write(0xff, 8 - this.count);
    return Uint8Array.from(this.bytes);
  }

  private flushByte(): void {
    this.bytes.push(this.current);
    if (this.current === 0xff) this.bytes.push(0);
    this.current = 0;
    this.count = 0;
  }
}

function jpegSegment(marker: number, data: number[]): number[] {
  const length = data.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...data];
}

function magnitudeCategory(value: number): number {
  let magnitude = Math.abs(value);
  let category = 0;
  while (magnitude > 0) {
    category += 1;
    magnitude >>= 1;
  }
  return category;
}

/**
 * Encodes a solid color as baseline JPEG. With a unit quantization table every block carries only a DC term, so one
 * DC table holding the few categories in use and an AC table holding only end-of-block describe the whole image.
 */
function encodeJpeg(width: number, height: number, color: Rgba): Uint8Array {
  const y = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  const cb = 128 - 0.168736 * color.r - 0.331264 * color.g + 0.5 * color.b;
  const cr = 128 + 0.5 * color.r - 0.418688 * color.g - 0.081312 * color.b;
  const dcs = [y, cb, cr].map((value) => Math.max(-1023, Math.min(1023, Math.round((value - 128) * 8))));
  const categories = [...new Set([0, ...dcs.map(magnitudeCategory)])];
  const codes = new Map<number, { code: number; length: number }>();
  categories.forEach((category, index) => codes.set(category, { code: (1 << (index + 1)) - 2, length: index + 1 }));
  const dcBits = Array.from({ length: 16 }, (_, index) => (index < categories.length ? 1 : 0));

  const writer = new MsbBitWriter();
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  for (let block = 0; block < blocks; block += 1) {
    for (const dc of dcs) {
      const diff = block === 0 ? dc : 0;
      const category = magnitudeCategory(diff);
      const huffman = codes.get(category);
      if (!huffman) throw new Error("missing JPEG DC code");
      writer.write(huffman.code, huffman.length);
      if (category > 0) writer.write(diff < 0 ? diff + (1 << category) - 1 : diff, category);
      writer.write(0, 1);
    }
  }

  const header = [
    0xff,
    0xd8,
    ...jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...jpegSegment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]),
    ...jpegSegment(0xc4, [0x00, ...dcBits, ...categories, 0x10, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...jpegSegment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
  ];
  return concat([Uint8Array.from(header), writer.finish(), Uint8Array.from([0xff, 0xd9])]);
}

/** Writes bits least significant first, as WebP lossless and GIF LZW streams require. */
class LsbBitWriter {
  bytes: number[] = [];
  private current = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let bit = 0; bit < length; bit += 1) {
      this.current |= ((value >>> bit) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.count = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.count > 0) this.bytes.push(this.current);
    this.current = 0;
    this.count = 0;
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Encodes a solid color as lossless WebP. Each of the five prefix codes is a one-symbol simple code, which spends zero
 * bits per pixel, so the bitstream ends after the header.
 */
function encodeWebp(width: number, height: number, color: Rgba): Uint8Array {
  const writer = new LsbBitWriter();
  writer.write(0x2f, 8);
  writer.write(width - 1, 14);
  writer.write(height - 1, 14);
  writer.write(color.a < 255 ? 1 : 0, 1);
  writer.write(0, 3);
  writer.write(0, 1);
  writer.write(0, 1);
  writer.write(0, 1);
  for (const symbol of [color.g, color.r, color.b, color.a, 0]) {
    writer.write(1, 1);
    writer.write(0, 1);
    writer.write(1, 1);
    writer.write(symbol, 8);
  }
  const data = writer.finish();
  const padded = data.length % 2 === 1 ? concat([data, new Uint8Array(1)]) : data;
  const chunk = concat([new TextEncoder().encode("VP8L"), u32le(data.length), padded]);
  return concat([new TextEncoder().encode("RIFF"), u32le(4 + chunk.length), new TextEncoder().encode("WEBP"), chunk]);
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** Encodes a solid color as a single-frame GIF with a two-entry palette and an LZW stream of one repeated index. */
function encodeGif(width: number, height: number, color: Rgba): Uint8Array {
  const transparent = color.a < 255;
  const writer = new LsbBitWriter();
  const clear = 4;
  const end = 5;
  let size = 3;
  let next = 6;
  writer.write(clear, size);
  const pixels = width * height;
  let run = 0;
  let emitted = 0;
  while (emitted < pixels) {
    const length = Math.min(run + 1, pixels - emitted);
    writer.write(length === 1 ? 0 : next - 1, size);
    emitted += length;
    run = length;
    if (next < 4096) {
      if (next === 1 << size && size < 12) size += 1;
      next += 1;
    } else {
      writer.write(clear, size);
      size = 3;
      next = 6;
      run = 0;
    }
  }
  writer.write(end, size);
  const lzw = writer.finish();
  const blocks: number[] = [];
  for (let at = 0; at < lzw.length; at += 255) {
    const block = lzw.subarray(at, at + 255);
    blocks.push(block.length, ...block);
  }
  return Uint8Array.from([
    ...new TextEncoder().encode("GIF89a"),
    ...u16le(width),
    ...u16le(height),
    0x80,
    0,
    0,
    color.r,
    color.g,
    color.b,
    0,
    0,
    0,
    ...(transparent ? [0x21, 0xf9, 4, 1, 0, 0, 0, 0] : []),
    0x2c,
    0,
    0,
    0,
    0,
    ...u16le(width),
    ...u16le(height),
    0,
    2,
    ...blocks,
    0,
    0x3b,
  ]);
}

function encodeSvg(width: number, height: number, color: Rgba): Uint8Array {
  const hex = [color.r, color.g, color.b].map((part) => part.toString(16).padStart(2, "0")).join("");
  const opacity = color.a < 255 ? ` fill-opacity="${(color.a / 255).toFixed(3)}"` : "";
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#${hex}"${opacity}/></svg>`,
  );
}
