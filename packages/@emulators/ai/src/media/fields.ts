import { createHash } from "node:crypto";
import { AiRequestError } from "../errors.js";
import type { FilePart } from "../types.js";
import type { MediaBody, UploadedFile } from "./route.js";

/** A request body as plain values: JSON as sent, or multipart fields folded so `a[]`, repeated `a`, and `a[b]` read like JSON. */
export interface Fields {
  values: Record<string, unknown>;
  files: Map<string, UploadedFile[]>;
  multipart: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws the client error every media route renders in its native error body. */
export function fail(message: string, param?: string, code = "invalid_value", status = 400): never {
  throw new AiRequestError(message, param, code, status);
}

/**
 * Reads a JSON or multipart body into plain values; a JSON body must be an object. Multipart values are built on
 * null-prototype objects, so a field named `__proto__[x]` stays an own property instead of reaching Object.prototype.
 */
export function fieldsOf(body: MediaBody): Fields {
  if (body.kind === "json") {
    if (!isRecord(body.value)) fail("Expected a JSON object body.", undefined, "invalid_json");
    return { values: body.value, files: new Map(), multipart: false };
  }
  if (body.kind === "none") return { values: {}, files: new Map(), multipart: false };
  const values: Record<string, unknown> = Object.create(null);
  for (const [name, list] of body.fields) {
    const nested = /^([^[\]]+)\[([^[\]]+)\](?:\[([^[\]]+)\])?$/.exec(name);
    if (name.endsWith("[]")) {
      values[name.slice(0, -2)] = [...((values[name.slice(0, -2)] as string[] | undefined) ?? []), ...list];
    } else if (nested) {
      const [, outer, inner, leaf] = nested;
      const parent = (isRecord(values[outer]) ? values[outer] : (values[outer] = Object.create(null))) as Record<
        string,
        unknown
      >;
      if (leaf === undefined) parent[inner] = list.at(-1);
      else
        ((isRecord(parent[inner]) ? parent[inner] : (parent[inner] = Object.create(null))) as Record<string, unknown>)[
          leaf
        ] = list.at(-1);
    } else {
      values[name] = list.length === 1 ? list[0] : list;
    }
  }
  const files = new Map<string, UploadedFile[]>();
  for (const [name, list] of body.files) {
    const key = name.endsWith("[]") ? name.slice(0, -2) : name;
    files.set(key, [...(files.get(key) ?? []), ...list]);
  }
  return { values, files, multipart: true };
}

export function requiredString(fields: Fields, key: string, maxLength?: number): string {
  const value = fields.values[key];
  if (value === undefined || value === null || value === "")
    fail(`Missing required parameter: '${key}'.`, key, "missing_required_parameter");
  if (typeof value !== "string") fail(`Invalid type for '${key}': expected a string.`, key, "invalid_type");
  if (maxLength !== undefined && value.length > maxLength) {
    fail(`'${key}' is too long. Maximum length is ${maxLength} characters.`, key, "string_above_max_length");
  }
  return value;
}

export function optionalString(fields: Fields, key: string): string | undefined {
  const value = fields.values[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`Invalid type for '${key}': expected a string.`, key, "invalid_type");
  return value;
}

export function optionalEnum<T extends string>(fields: Fields, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalString(fields, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(
      `Invalid value for '${key}': '${value}'. Supported values are: ${allowed.map((item) => `'${item}'`).join(", ")}.`,
      key,
    );
  }
  return value as T;
}

/** Reads an integer sent as a JSON number or, in multipart bodies, as decimal text. */
export function optionalInteger(fields: Fields, key: string, min: number, max: number): number | undefined {
  const raw = fields.values[key];
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" && fields.multipart && /^-?\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value))
    fail(`Invalid type for '${key}': expected an integer.`, key, "invalid_type");
  if (value < min)
    fail(
      `Invalid '${key}': integer below minimum value. Expected a value >= ${min}, but got ${value} instead.`,
      key,
      "integer_below_min_value",
    );
  if (value > max)
    fail(
      `Invalid '${key}': integer above maximum value. Expected a value <= ${max}, but got ${value} instead.`,
      key,
      "integer_above_max_value",
    );
  return value;
}

/** Reads a number sent as JSON or, in multipart bodies, as decimal text. */
export function optionalNumber(fields: Fields, key: string, min: number, max: number): number | undefined {
  const raw = fields.values[key];
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" && fields.multipart && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`Invalid type for '${key}': expected a number.`, key, "invalid_type");
  if (value < min || value > max) fail(`Invalid '${key}': expected a number between ${min} and ${max}.`, key);
  return value;
}

/** Reads a boolean sent as JSON or, in multipart bodies, as "true" or "false". */
export function optionalBoolean(fields: Fields, key: string): boolean | undefined {
  const raw = fields.values[key];
  if (raw === undefined || raw === null) return undefined;
  if (fields.multipart && (raw === "true" || raw === "false")) return raw === "true";
  if (typeof raw !== "boolean") fail(`Invalid type for '${key}': expected a boolean.`, key, "invalid_type");
  return raw;
}

/** Reads a list of strings sent as a JSON array or as repeated multipart fields. */
export function optionalStrings(fields: Fields, key: string): string[] | undefined {
  const raw = fields.values[key];
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.every((item) => typeof item === "string"))
    fail(`Invalid type for '${key}': expected an array of strings.`, key, "invalid_type");
  return list as string[];
}

/** Records an uploaded file as size and hash metadata, never the bytes. */
export function uploadedPart(file: UploadedFile, mediaType = file.type || "application/octet-stream"): FilePart {
  return {
    type: "file",
    mediaType,
    ...(file.name ? { name: file.name } : {}),
    source: "inline",
    bytes: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

/** Decodes rule-supplied base64 file bytes. */
export function base64Bytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** A deterministic token estimate of one token per four characters. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
