/** Frames per second of every rendered clip. */
export const VIDEO_FPS = 24;

/** Writes bits most significant first, with the Exp-Golomb codes H.264 headers use. */
class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private count = 0;

  bits(value: number, length: number): this {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.current = (this.current << 1) | ((value >>> bit) & 1);
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.count = 0;
      }
    }
    return this;
  }

  ue(value: number): this {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded));
    return this.bits(0, length).bits(coded, length + 1);
  }

  se(value: number): this {
    return this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** Ends the payload with the stop bit and zero padding to a byte boundary. */
  trailing(): Uint8Array {
    this.bits(1, 1);
    while (this.count !== 0) this.bits(0, 1);
    return Uint8Array.from(this.bytes);
  }
}

/** Wraps an RBSP in a NAL header, inserting emulation prevention bytes. */
function nal(type: number, rbsp: Uint8Array): Uint8Array {
  const out = [0x60 | type];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/**
 * The parameter sets and two IDR pictures (alternating `idr_pic_id` 1 and 2, which code to the same length) of a Baseline H.264 stream at any even size. Every
 * macroblock is I_16x16 with DC prediction and no residual, so each picture decodes to uniform mid gray.
 */
function h264(width: number, height: number): { sps: Uint8Array; pps: Uint8Array; idr: [Uint8Array, Uint8Array] } {
  const mbWidth = Math.ceil(width / 16);
  const mbHeight = Math.ceil(height / 16);
  const sps = new BitWriter().bits(66, 8).bits(0xc0, 8).bits(51, 8).ue(0).ue(0).ue(2).ue(1).bits(0, 1);
  sps
    .ue(mbWidth - 1)
    .ue(mbHeight - 1)
    .bits(1, 1)
    .bits(1, 1);
  const cropRight = (mbWidth * 16 - width) / 2;
  const cropBottom = (mbHeight * 16 - height) / 2;
  if (cropRight > 0 || cropBottom > 0) sps.bits(1, 1).ue(0).ue(cropRight).ue(0).ue(cropBottom);
  else sps.bits(0, 1);
  sps.bits(0, 1);
  const pps = new BitWriter().ue(0).ue(0).bits(0, 1).bits(0, 1).ue(0).ue(0).ue(0).bits(0, 1).bits(0, 2);
  pps.se(0).se(0).se(0).bits(1, 1).bits(0, 1).bits(0, 1);
  const slice = (idrPicId: number) => {
    const writer = new BitWriter().ue(0).ue(7).ue(0).bits(0, 4).ue(idrPicId).bits(0, 1).bits(0, 1).se(0).ue(1);
    for (let mb = 0; mb < mbWidth * mbHeight; mb += 1) writer.ue(3).ue(0).se(0).bits(1, 1);
    return nal(5, writer.trailing());
  };
  return { sps: nal(7, sps.trailing()), pps: nal(8, pps.trailing()), idr: [slice(1), slice(2)] };
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, ...parts: Array<number[] | Uint8Array>): number[] {
  const body = parts.flatMap((part) => [...part]);
  return [...u32(8 + body.length), ...[...type].map((char) => char.charCodeAt(0)), ...body];
}

function fullBox(type: string, version: number, flags: number, ...parts: Array<number[] | Uint8Array>): number[] {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

const MATRIX = [
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x40000000),
];

/**
 * Renders a silent, uniform gray H.264 MP4 of the given size and duration at 24 fps. The two encoded pictures are stored
 * once and every sample points at one of them.
 */
export function renderVideo(width: number, height: number, seconds: number): Uint8Array {
  const evenWidth = Math.max(16, width + (width % 2));
  const evenHeight = Math.max(16, height + (height % 2));
  const { sps, pps, idr } = h264(evenWidth, evenHeight);
  const frames = Math.max(1, Math.round(seconds * VIDEO_FPS));
  const sample = (picture: Uint8Array) => [...u32(picture.length), ...picture];
  const samples = [sample(idr[0]), sample(idr[1])];
  const avcC = box("avcC", [1, 66, 0xc0, 51, 0xff, 0xe1, ...u16(sps.length), ...sps, 1, ...u16(pps.length), ...pps]);
  const avc1 = box(
    "avc1",
    [0, 0, 0, 0, 0, 0, ...u16(1), ...new Array(16).fill(0), ...u16(evenWidth), ...u16(evenHeight)],
    [...u32(0x480000), ...u32(0x480000), ...u32(0), ...u16(1), ...new Array(32).fill(0), ...u16(0x18), ...u16(0xffff)],
    avcC,
  );
  const durationMs = Math.round((frames / VIDEO_FPS) * 1000);
  const moov = (offsets: number[]) =>
    box(
      "moov",
      fullBox(
        "mvhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(1000),
        u32(durationMs),
        u32(0x10000),
        u16(0x100),
        new Array(10).fill(0),
        MATRIX,
        new Array(24).fill(0),
        u32(2),
      ),
      box(
        "trak",
        fullBox(
          "tkhd",
          0,
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(durationMs),
          new Array(8).fill(0),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          MATRIX,
          u32(evenWidth << 16),
          u32(evenHeight << 16),
        ),
        box(
          "mdia",
          fullBox("mdhd", 0, 0, u32(0), u32(0), u32(VIDEO_FPS), u32(frames), u16(0x55c4), u16(0)),
          fullBox(
            "hdlr",
            0,
            0,
            u32(0),
            [..."vide"].map((char) => char.charCodeAt(0)),
            new Array(12).fill(0),
            [...new TextEncoder().encode("VideoHandler"), 0],
          ),
          box(
            "minf",
            fullBox("vmhd", 0, 1, new Array(8).fill(0)),
            box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
            box(
              "stbl",
              fullBox("stsd", 0, 0, u32(1), avc1),
              fullBox("stts", 0, 0, u32(1), u32(frames), u32(1)),
              fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
              fullBox("stsz", 0, 0, u32(samples[0].length), u32(frames)),
              fullBox("stco", 0, 0, u32(frames), offsets.flatMap(u32)),
            ),
          ),
        ),
      ),
    );
  const ftyp = box(
    "ftyp",
    [..."isom"].map((char) => char.charCodeAt(0)),
    u32(512),
    [..."isomiso2avc1mp41"].map((char) => char.charCodeAt(0)),
  );
  const moovLength = moov(new Array(frames).fill(0)).length;
  const dataStart = ftyp.length + moovLength + 8;
  const offsets = Array.from({ length: frames }, (_, index) => dataStart + (index % 2) * samples[0].length);
  const mdat = box("mdat", samples[0], samples[1]);
  return Uint8Array.from([...ftyp, ...moov(offsets), ...mdat]);
}
