/** Audio containers and encodings the emulator can render without fixtures. */
export type AudioFormat = "mp3" | "wav" | "pcm" | "flac" | "opus" | "aac" | "ulaw" | "alaw";

/** Media types for each rendered audio format; PCM carries its rate the way Gemini labels raw L16 audio. */
export const AUDIO_MEDIA_TYPES: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
  flac: "audio/flac",
  opus: "audio/ogg",
  aac: "audio/aac",
  ulaw: "audio/basic",
  alaw: "audio/x-alaw-basic",
};

/** An audio clip's shape: mono 16-bit samples at `sampleRate`, lasting `seconds`. */
export interface AudioShape {
  seconds: number;
  sampleRate: number;
}

const SILENT_AAC_24K = Uint8Array.from([0xff, 0xf1, 0x58, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07]);
const SILENT_OPUS = Uint8Array.from([0xf8, 0xff, 0xfe]);

/** Seconds a speech clip lasts for `text`: about fifteen characters a second at speed 1, never under half a second. */
export function speechSeconds(text: string, speed = 1): number {
  return Math.max(0.5, Math.round((text.length / 15 / speed) * 100) / 100);
}

/** Renders silence of the given shape as a real, decodable file. */
export function renderAudio(format: AudioFormat, shape: AudioShape): Uint8Array {
  const samples = Math.max(1, Math.round(shape.seconds * shape.sampleRate));
  switch (format) {
    case "pcm":
      return new Uint8Array(samples * 2);
    case "wav":
      return wav(samples, shape.sampleRate);
    case "mp3":
      return mp3(shape);
    case "flac":
      return flac(samples, shape.sampleRate);
    case "opus":
      return opus(shape.seconds);
    case "aac":
      return repeat(SILENT_AAC_24K, Math.max(1, Math.ceil((shape.seconds * 24000) / 1024)));
    case "ulaw":
      return new Uint8Array(samples).fill(0xff);
    case "alaw":
      return new Uint8Array(samples).fill(0xd5);
  }
}

/** Reads the duration of a WAV file from its header, or estimates it at 128 kbit/s for anything else. */
export function audioSeconds(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 44 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") {
    let at = 12;
    let byteRate = 0;
    while (at + 8 <= bytes.length) {
      const id = ascii(bytes, at, at + 4);
      const size = view.getUint32(at + 4, true);
      if (id === "fmt " && at + 16 <= bytes.length) byteRate = view.getUint32(at + 16, true);
      if (id === "data" && byteRate > 0)
        return Math.round((Math.min(size, bytes.length - at - 8) / byteRate) * 100) / 100;
      at += 8 + size + (size % 2);
    }
  }
  return Math.max(0.5, Math.round((bytes.length / 16000) * 100) / 100);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function repeat(frame: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(frame.length * count);
  for (let index = 0; index < count; index += 1) out.set(frame, index * frame.length);
  return out;
}

/** Wraps 16-bit mono PCM in a RIFF WAVE header. */
export function wavFromPcm(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + pcm.length, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function wav(samples: number, sampleRate: number): Uint8Array {
  return wavFromPcm(new Uint8Array(samples * 2), sampleRate);
}

const MP3_RATES: Record<number, { version: 1 | 2; index: number }> = {
  44100: { version: 1, index: 0 },
  48000: { version: 1, index: 1 },
  32000: { version: 1, index: 2 },
  22050: { version: 2, index: 0 },
  24000: { version: 2, index: 1 },
  16000: { version: 2, index: 2 },
};

/**
 * Layer III frames at 128 kbit/s for MPEG-1 rates and 32 kbit/s for MPEG-2 rates, mono, falling back to 24 kHz; zeroed
 * side information decodes as silence.
 */
function mp3({ seconds, sampleRate }: AudioShape): Uint8Array {
  const rate = MP3_RATES[sampleRate] ? sampleRate : 24000;
  const { version, index } = MP3_RATES[rate];
  const frame = new Uint8Array(Math.floor(((version === 1 ? 144 : 72) * (version === 1 ? 128000 : 32000)) / rate));
  frame.set([0xff, version === 1 ? 0xfb : 0xf3, ((version === 1 ? 9 : 4) << 4) | (index << 2), 0xc4]);
  return repeat(frame, Math.max(1, Math.ceil((seconds * rate) / (version === 1 ? 1152 : 576))));
}

function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function crc16(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function utf8Number(value: number): number[] {
  if (value < 0x80) return [value];
  if (value < 0x800) return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
  if (value < 0x10000) return [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];
  return [0xf0 | (value >> 18), 0x80 | ((value >> 12) & 0x3f), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];
}

/** FLAC with fixed 4096-sample blocks, each a single CONSTANT subframe of zero. */
function flac(samples: number, sampleRate: number): Uint8Array {
  const block = 4096;
  const info = new Uint8Array(34);
  const view = new DataView(info.buffer);
  view.setUint16(0, block);
  view.setUint16(2, block);
  const packed = (BigInt(sampleRate) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(samples);
  view.setBigUint64(10, packed);
  const out: number[] = [...new TextEncoder().encode("fLaC"), 0x80, 0, 0, 34, ...info];
  for (let frame = 0, start = 0; start < samples; frame += 1, start += block) {
    const size = Math.min(block, samples - start);
    const header = [0xff, 0xf8, 0x70, 0x08, ...utf8Number(frame), (size - 1) >> 8, (size - 1) & 0xff];
    header.push(crc8(header));
    const body = [...header, 0x00, 0x00, 0x00];
    const crc = crc16(body);
    out.push(...body, crc >> 8, crc & 0xff);
  }
  return Uint8Array.from(out);
}

const OGG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  return crc >>> 0;
});

function oggPage(packets: Uint8Array[], flags: number, granule: bigint, sequence: number): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  const body = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"), 0);
  page[5] = flags;
  view.setBigUint64(6, granule, true);
  view.setUint32(14, 0x656d75, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  view.setUint32(22, crc, true);
  return page;
}

/** Ogg Opus with 20 ms silent CELT packets, fifty to a page. */
function opus(seconds: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 1;
  new DataView(head.buffer).setUint16(10, 312, true);
  new DataView(head.buffer).setUint32(12, 48000, true);
  const vendor = new TextEncoder().encode("emulate");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [oggPage([head], 0x02, 0n, 0), oggPage([tags], 0, 0n, 1)];
  const packets = Math.max(1, Math.ceil(seconds * 50));
  for (let sent = 0, sequence = 2; sent < packets; sequence += 1) {
    const count = Math.min(50, packets - sent);
    sent += count;
    const granule = BigInt(312 + sent * 960);
    pages.push(
      oggPage(
        Array.from({ length: count }, () => SILENT_OPUS),
        sent === packets ? 0x04 : 0,
        granule,
        sequence,
      ),
    );
  }
  const out = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}

/** Detects an audio media type from its leading bytes. */
export function sniffAudioType(bytes: Uint8Array): string | undefined {
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
  if (bytes[0] === 0xff && [0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2].includes(bytes[1])) return "audio/mpeg";
  return undefined;
}
