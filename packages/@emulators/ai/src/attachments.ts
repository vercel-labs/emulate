import { createHash } from "node:crypto";
import type { FilePart } from "./types.js";
import { AiRequestError } from "./errors.js";

const MAX_OPENAI_FILE_BYTES = 50_000_000;
const MAX_OPENAI_IMAGE_BYTES = 512_000_000;
const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const EXTENSION_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
};

function fail(message: string, path: string): never {
  throw new AiRequestError(message, path, "invalid_attachment");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("Expected a string.", path);
  return value;
}

function inferredMediaType(name: string | undefined): string {
  const extension = name?.split(".").pop()?.toLowerCase();
  return extension !== undefined && Object.hasOwn(EXTENSION_TYPES, extension)
    ? EXTENSION_TYPES[extension]
    : "application/octet-stream";
}

function stripUrl(url: URL): string {
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function checkedUrl(value: unknown, path: string): string {
  if (typeof value !== "string") fail("Expected an HTTPS URL.", path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("Expected an HTTPS URL.", path);
  }
  if (url.protocol !== "https:") fail("Expected an HTTPS URL.", path);
  return stripUrl(url);
}

/** Strips credentials, query, and hash from an attachment URL, keeping its protocol. */
export function redactedUrl(value: unknown, path: string): string {
  if (typeof value !== "string") fail("Expected a URL.", path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("Expected a URL.", path);
  }
  return stripUrl(url);
}

function decodeBase64(value: string, path: string, maxBytes: number): Buffer {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 2) fail("Inline attachment exceeds the size limit.", path);
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail("Malformed base64 data.", path);
  }
  const unpadded = value.replace(/=+$/, "");
  if (value.includes("=") && value.length % 4 !== 0) fail("Malformed base64 data.", path);
  const normalized = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== unpadded) fail("Malformed base64 data.", path);
  if (bytes.length > maxBytes) fail("Inline attachment exceeds the size limit.", path);
  return bytes;
}

/** Records a base64 attachment as size and hash metadata, never the bytes. */
export function inlineFilePart(
  value: string,
  mediaType: string,
  path: string,
  maxBytes: number,
  name?: string,
): FilePart {
  const bytes = decodeBase64(value, path, maxBytes);
  return {
    type: "file",
    mediaType,
    ...(name === undefined ? {} : { name }),
    source: "inline",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function inlineAttachment(
  value: string,
  name: string | undefined,
  path: string,
  maxBytes: number,
  rawAllowed: boolean,
): FilePart {
  let mediaType = inferredMediaType(name);
  let encoded = value;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (dataUrl) {
    mediaType = dataUrl[1].toLowerCase();
    encoded = dataUrl[2];
  } else if (value.startsWith("data:")) {
    fail("Malformed base64 data URL.", path);
  } else if (!rawAllowed) {
    fail("Expected a base64 data URL.", path);
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    fail("Invalid attachment media type.", path);
  }
  return inlineFilePart(encoded, mediaType, path, maxBytes, name);
}

function requireDetail(value: unknown, path: string, allowed: string[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    fail(`Expected one of ${allowed.join(", ")}.`, path);
  }
}

function fileName(value: unknown, path: string): string | undefined {
  const name = optionalString(value, path);
  if (name === "") fail("Filename must not be empty.", path);
  return name;
}

function responsesFile(part: Record<string, unknown>, path: string): FilePart {
  const name = fileName(part.filename, `${path}.filename`);
  requireDetail(part.detail, `${path}.detail`, ["auto", "low", "high"]);
  const sourceCount = [part.file_data, part.file_id, part.file_url].filter((value) => value !== undefined).length;
  if (sourceCount !== 1) fail("Provide exactly one of file_data, file_id, or file_url.", path);
  if (part.file_data !== undefined) {
    if (typeof part.file_data !== "string") fail("Expected a string.", `${path}.file_data`);
    return inlineAttachment(part.file_data, name, `${path}.file_data`, MAX_OPENAI_FILE_BYTES, true);
  }
  if (part.file_id !== undefined) {
    if (typeof part.file_id !== "string" || part.file_id.length === 0)
      fail("Expected a non-empty file id.", `${path}.file_id`);
    return {
      type: "file",
      mediaType: inferredMediaType(name),
      ...(name === undefined ? {} : { name }),
      source: "file_id",
      ref: part.file_id,
    };
  }
  const ref = checkedUrl(part.file_url, `${path}.file_url`);
  return {
    type: "file",
    mediaType: inferredMediaType(name ?? new URL(ref).pathname),
    ...(name === undefined ? {} : { name }),
    source: "url",
    ref,
  };
}

function responsesImage(part: Record<string, unknown>, path: string): FilePart {
  requireDetail(part.detail, `${path}.detail`, ["auto", "low", "high", "original"]);
  const sourceCount = [part.image_url, part.file_id].filter((value) => value !== undefined).length;
  if (sourceCount !== 1) fail("Provide exactly one of image_url or file_id.", path);
  if (part.file_id !== undefined) {
    if (typeof part.file_id !== "string" || part.file_id.length === 0)
      fail("Expected a non-empty file id.", `${path}.file_id`);
    return { type: "file", mediaType: "image/*", source: "file_id", ref: part.file_id };
  }
  return imageAttachment(part.image_url, `${path}.image_url`);
}

function imageAttachment(value: unknown, path: string): FilePart {
  if (typeof value !== "string") fail("Expected an image URL.", path);
  if (value.startsWith("data:")) {
    const result = inlineAttachment(value, undefined, path, MAX_OPENAI_IMAGE_BYTES, false);
    if (!IMAGE_TYPES.has(result.mediaType)) fail("Unsupported image media type.", path);
    return result;
  }
  const ref = checkedUrl(value, path);
  const mediaType = inferredMediaType(new URL(ref).pathname);
  return { type: "file", mediaType: mediaType.startsWith("image/") ? mediaType : "image/*", source: "url", ref };
}

function chatFile(part: Record<string, unknown>, path: string): FilePart {
  if (!isObject(part.file)) fail("Expected a file object.", `${path}.file`);
  const file = part.file;
  const name = fileName(file.filename, `${path}.file.filename`);
  if (file.file_url !== undefined) fail("Chat file parts do not support file_url.", `${path}.file.file_url`);
  const sourceCount = [file.file_data, file.file_id].filter((value) => value !== undefined).length;
  if (sourceCount !== 1) fail("Provide exactly one of file_data or file_id.", `${path}.file`);
  if (name !== undefined && inferredMediaType(name) !== "application/pdf") {
    fail("Chat file attachments must be PDF files.", `${path}.file.filename`);
  }
  if (file.file_id !== undefined) {
    if (typeof file.file_id !== "string" || file.file_id.length === 0)
      fail("Expected a non-empty file id.", `${path}.file.file_id`);
    return {
      type: "file",
      mediaType: "application/pdf",
      ...(name === undefined ? {} : { name }),
      source: "file_id",
      ref: file.file_id,
    };
  }
  if (typeof file.file_data !== "string") fail("Expected a string.", `${path}.file.file_data`);
  const result = inlineAttachment(file.file_data, name, `${path}.file.file_data`, MAX_OPENAI_FILE_BYTES, true);
  if (result.mediaType !== "application/pdf")
    fail("Chat file attachments must be PDF files.", `${path}.file.file_data`);
  return result;
}

function chatImage(part: Record<string, unknown>, path: string): FilePart {
  if (!isObject(part.image_url)) fail("Expected an image_url object.", `${path}.image_url`);
  const image = part.image_url;
  requireDetail(image.detail, `${path}.image_url.detail`, ["auto", "low", "high", "original"]);
  return imageAttachment(image.url, `${path}.image_url.url`);
}

/** Decodes an OpenAI Chat attachment into metadata without retaining inline bytes. */
export function decodeChatAttachment(part: unknown, path: string): FilePart | null {
  if (!isObject(part)) return null;
  if (part.type === "file") return chatFile(part, path);
  if (part.type === "image_url") return chatImage(part, path);
  return null;
}

/** Decodes an OpenAI Responses attachment into metadata without retaining inline bytes. */
export function decodeResponsesAttachment(part: unknown, path: string): FilePart | null {
  if (!isObject(part)) return null;
  if (part.type === "input_file") return responsesFile(part, path);
  if (part.type === "input_image") return responsesImage(part, path);
  return null;
}
