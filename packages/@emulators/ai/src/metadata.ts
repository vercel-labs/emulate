import { AiRequestError } from "./errors.js";

const MAX_PAIRS = 16;
const MAX_KEY = 64;
const MAX_VALUE = 512;

/** Validates OpenAI request metadata: at most 16 pairs, keys up to 64 characters, string values up to 512. */
export function decodeMetadata(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AiRequestError("Expected an object for 'metadata'.", "metadata");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_PAIRS) {
    throw new AiRequestError(`Expected at most ${MAX_PAIRS} key-value pairs for 'metadata'.`, "metadata");
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of entries) {
    const param = `metadata.${key}`;
    if (key.length > MAX_KEY) {
      throw new AiRequestError(`Expected a key of at most ${MAX_KEY} characters in 'metadata'.`, "metadata");
    }
    if (typeof value !== "string") throw new AiRequestError(`Expected a string for '${param}'.`, param);
    if (value.length > MAX_VALUE) {
      throw new AiRequestError(`Expected a string of at most ${MAX_VALUE} characters for '${param}'.`, param);
    }
    metadata[key] = value;
  }
  return metadata;
}
