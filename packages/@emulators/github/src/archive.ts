import { crc32, gzipSync } from "zlib";

export interface ArchiveEntry {
  /** Slash-separated path inside the archive. Directory paths end with "/". */
  path: string;
  kind: "file" | "dir" | "symlink";
  /** Unix permission bits, for example 0o644 or 0o755. */
  mode: number;
  /** File bytes, or the link target for symlinks. Empty for directories. */
  data: Buffer;
}

export interface ArchiveOptions {
  /** Modification time recorded on every entry. */
  mtime: Date;
  /** Recorded in a pax global header, the way `git archive` records the commit sha. */
  comment?: string;
}

const TAR_BLOCK = 512;
const TAR_RECORD = 10240;
const TAR_NAME_LENGTH = 100;
const TAR_PREFIX_LENGTH = 155;
const EMPTY = Buffer.alloc(0);

function unixSeconds(date: Date): number {
  const milliseconds = date.getTime();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
}

function padToBlock(data: Buffer): Buffer {
  const remainder = data.byteLength % TAR_BLOCK;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(TAR_BLOCK - remainder)]);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

interface TarHeaderFields {
  name: string;
  prefix?: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: "0" | "2" | "5" | "g" | "x";
  linkname?: string;
}

function tarHeader(fields: TarHeaderFields): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(fields.name, 0, TAR_NAME_LENGTH, "utf8");
  writeOctal(header, 100, 8, fields.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, fields.size);
  writeOctal(header, 136, 12, fields.mtime);
  header.write(fields.typeflag, 156, 1, "ascii");
  if (fields.linkname) header.write(fields.linkname, 157, TAR_NAME_LENGTH, "utf8");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "utf8");
  header.write("root", 297, 32, "utf8");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (fields.prefix) header.write(fields.prefix, 345, TAR_PREFIX_LENGTH, "utf8");

  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Split a long path across the ustar name and prefix fields, or undefined when it does not fit. */
function splitTarName(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path, "utf8") <= TAR_NAME_LENGTH) return { name: path, prefix: "" };
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (!name) continue;
    if (Buffer.byteLength(prefix, "utf8") <= TAR_PREFIX_LENGTH && Buffer.byteLength(name, "utf8") <= TAR_NAME_LENGTH) {
      return { name, prefix };
    }
  }
  return undefined;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body, "utf8");
  let digits = 1;
  while (String(digits + bodyLength).length > digits) digits++;
  return `${digits + bodyLength}${body}`;
}

function tarEntry(entry: ArchiveEntry, mtime: number): Buffer[] {
  const typeflag = entry.kind === "dir" ? "5" : entry.kind === "symlink" ? "2" : "0";
  const data = entry.kind === "file" ? entry.data : EMPTY;
  const linkname = entry.kind === "symlink" ? entry.data.toString("utf8") : "";
  const split = splitTarName(entry.path);

  const records: string[] = [];
  if (!split) records.push(paxRecord("path", entry.path));
  if (Buffer.byteLength(linkname, "utf8") > TAR_NAME_LENGTH) records.push(paxRecord("linkpath", linkname));

  const blocks: Buffer[] = [];
  if (records.length) {
    const pax = Buffer.from(records.join(""), "utf8");
    blocks.push(
      tarHeader({ name: `PaxHeaders/${entry.path}`, mode: 0o644, size: pax.byteLength, mtime, typeflag: "x" }),
      padToBlock(pax),
    );
  }
  blocks.push(
    tarHeader({
      name: split?.name ?? entry.path,
      prefix: split?.prefix,
      mode: entry.mode,
      size: data.byteLength,
      mtime,
      typeflag,
      linkname,
    }),
  );
  if (data.byteLength) blocks.push(padToBlock(data));
  return blocks;
}

/** Gzipped ustar archive. Long paths fall back to pax extended headers. */
export function createTarball(entries: ArchiveEntry[], options: ArchiveOptions): Buffer {
  const mtime = unixSeconds(options.mtime);
  const blocks: Buffer[] = [];
  if (options.comment) {
    const pax = Buffer.from(paxRecord("comment", options.comment), "utf8");
    blocks.push(
      tarHeader({ name: "pax_global_header", mode: 0o666, size: pax.byteLength, mtime, typeflag: "g" }),
      padToBlock(pax),
    );
  }
  for (const entry of entries) blocks.push(...tarEntry(entry, mtime));
  blocks.push(Buffer.alloc(TAR_BLOCK * 2));

  const tar = Buffer.concat(blocks);
  const remainder = tar.byteLength % TAR_RECORD;
  return gzipSync(remainder === 0 ? tar : Buffer.concat([tar, Buffer.alloc(TAR_RECORD - remainder)]));
}

function dosDateTime(date: Date): { time: number; date: number } {
  const valid =
    Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1980 ? date : new Date(Date.UTC(1980, 0, 1));
  return {
    time: (valid.getUTCHours() << 11) | (valid.getUTCMinutes() << 5) | (valid.getUTCSeconds() >> 1),
    date: ((valid.getUTCFullYear() - 1980) << 9) | ((valid.getUTCMonth() + 1) << 5) | valid.getUTCDate(),
  };
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
const ZIP_UTF8_NAMES = 0x0800;
const ZIP_DIRECTORY_ATTRIBUTE = 0x10;

/**
 * Zip archive with stored (uncompressed) entries and Unix modes in the external
 * attributes, matching `git archive --format=zip`. Zip64 is not supported.
 */
export function createZipball(entries: ArchiveEntry[], options: ArchiveOptions): Buffer {
  const { time, date } = dosDateTime(options.mtime);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.kind === "dir" ? EMPTY : entry.data;
    const checksum = crc32(data);
    const typeBits = entry.kind === "dir" ? 0o040000 : entry.kind === "symlink" ? 0o120000 : 0o100000;
    const external = (((typeBits | entry.mode) << 16) | (entry.kind === "dir" ? ZIP_DIRECTORY_ATTRIBUTE : 0)) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    central.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(ZIP_UTF8_NAMES, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}
