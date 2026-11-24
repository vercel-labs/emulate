import { zlibSync } from "fflate";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc;
});

/** CRC-32 of the bytes, continuing from `value` like node's zlib.crc32. */
export function crc32(data: Uint8Array, value = 0): number {
  let crc = ~value >>> 0;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Compresses bytes into a zlib stream, the format node's zlib.deflateSync writes. */
export function deflateSync(data: Uint8Array): Uint8Array {
  return zlibSync(data);
}

export function zstdDecompressSync(): never {
  throw new Error("zlib.zstdDecompressSync is not available in the browser playground");
}
