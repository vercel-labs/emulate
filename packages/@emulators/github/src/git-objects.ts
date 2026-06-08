import { createHash } from "crypto";
import { deflateSync } from "zlib";

/**
 * Minimal pure-TypeScript git object model used by the smart HTTP endpoints.
 * Builds loose objects (blob, tree, commit), computes their canonical object
 * ids, and assembles version 2 packfiles. No git binary, filesystem access, or
 * external dependency is involved; everything is derived from in-memory data.
 */

export type GitObjectType = "commit" | "tree" | "blob";

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_SHA = "0".repeat(40);

const PACK_TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

export function gitObjectSha(obj: GitObject): string {
  return createHash("sha1").update(`${obj.type} ${obj.data.length}\0`).update(obj.data).digest("hex");
}

export interface GitTreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Tree entry modes as stored in the REST-facing rows ("040000") vs the on-wire tree object ("40000"). */
function wireMode(mode: string): string {
  return mode === "040000" ? "40000" : mode;
}

function treeSortKey(entry: GitTreeEntry): Buffer {
  const isTree = wireMode(entry.mode) === "40000";
  return Buffer.from(isTree ? `${entry.name}/` : entry.name, "utf8");
}

/** Canonical git tree order: byte-wise by name, with directories compared as "name/". */
export function compareTreeEntries(a: GitTreeEntry, b: GitTreeEntry): number {
  return Buffer.compare(treeSortKey(a), treeSortKey(b));
}

export function serializeTree(entries: GitTreeEntry[]): GitObject {
  const sorted = [...entries].sort(compareTreeEntries);
  const data = Buffer.concat(
    sorted.flatMap((entry) => [Buffer.from(`${wireMode(entry.mode)} ${entry.name}\0`, "utf8"), shaToBytes(entry.sha)]),
  );
  return { type: "tree", data };
}

function shaToBytes(sha: string): Buffer {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`invalid object id: ${sha}`);
  }
  return Buffer.from(sha, "hex");
}

export interface GitCommitMeta {
  treeSha: string;
  parentShas: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

export function serializeCommit(meta: GitCommitMeta): GitObject {
  const lines = [`tree ${meta.treeSha}`];
  for (const parent of meta.parentShas) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${identityLine(meta.authorName, meta.authorEmail, meta.authorDate)}`);
  lines.push(`committer ${identityLine(meta.committerName, meta.committerEmail, meta.committerDate)}`);
  const message = meta.message.endsWith("\n") ? meta.message : `${meta.message}\n`;
  return { type: "commit", data: Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8") };
}

export function serializeBlob(content: string, encoding: "base64" | "utf-8"): GitObject {
  return { type: "blob", data: Buffer.from(content, encoding) };
}

function identityLine(name: string, email: string, isoDate: string): string {
  const millis = Date.parse(isoDate);
  const seconds = Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
  return `${sanitizeIdentity(name) || "emulate"} <${sanitizeIdentity(email)}> ${seconds} +0000`;
}

function sanitizeIdentity(value: string): string {
  return value.replace(/[<>\n]/g, "").trim();
}

export function buildPackfile(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const chunks: Buffer[] = [header];
  for (const obj of objects) {
    chunks.push(packEntryHeader(PACK_TYPE_NUMBERS[obj.type], obj.data.length), deflateSync(obj.data));
  }
  const trailer = createHash("sha1");
  for (const chunk of chunks) {
    trailer.update(chunk);
  }
  return Buffer.concat([...chunks, trailer.digest()]);
}

function packEntryHeader(typeNumber: number, size: number): Buffer {
  const bytes: number[] = [];
  let current = (typeNumber << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(current | 0x80);
    current = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

export const FLUSH_PKT = Buffer.from("0000", "ascii");

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (data.length + 4 > 0xffff) {
    throw new Error("pkt-line payload too large");
  }
  const length = (data.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "ascii"), data]);
}

/** Parses a pkt-line stream into payload strings. Flush pkts are skipped; malformed lengths throw. */
export function parsePktLines(body: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      throw new Error("truncated pkt-line stream");
    }
    const lengthHex = body.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(lengthHex)) {
      throw new Error("invalid pkt-line length");
    }
    const length = parseInt(lengthHex, 16);
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) {
      throw new Error("invalid pkt-line length");
    }
    const payload = body.subarray(offset + 4, offset + length).toString("utf8");
    lines.push(payload.endsWith("\n") ? payload.slice(0, -1) : payload);
    offset += length;
  }
  return lines;
}
