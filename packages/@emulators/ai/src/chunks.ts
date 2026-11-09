/** Splits text into word-sized pieces, keeping trailing whitespace with the word. */
export function textChunks(value: string): string[] {
  if (value.length === 0) return [];
  const pieces: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    while (index < value.length && space.test(value[index])) index += 1;
    const wordStart = index;
    while (index < value.length && !space.test(value[index])) index += 1;
    if (index === wordStart) break;
    while (index < value.length && space.test(value[index])) index += 1;
    pieces.push(value.slice(start, index));
    start = index;
  }
  return pieces.length > 0 ? pieces : [value];
}

const jsonPieceFloor = 8;
const space = /\s/;

/**
 * Splits compact JSON into pieces that break between structural characters and never inside a
 * string, so partial prefixes stay safe to parse.
 */
export function jsonChunks(value: string): string[] {
  if (value.length === 0) return [];
  const pieces: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    const boundary = char === "," || char === ":" || char === "{" || char === "[" || char === "}" || char === "]";
    if (!boundary) continue;
    if (index + 1 - start < jsonPieceFloor && index !== value.length - 1) continue;
    pieces.push(value.slice(start, index + 1));
    start = index + 1;
  }

  if (start < value.length) pieces.push(value.slice(start));
  if (pieces.length === 0) pieces.push(value);
  return pieces;
}

/** Chunks reply text; a single piece that looks like compact JSON is split as JSON instead. */
export function payloadChunks(value: string): string[] {
  const pieces = textChunks(value);
  const trimmed = value.trim();
  if (pieces.length === 1 && trimmed.length > jsonPieceFloor && /^[[{]/.test(trimmed)) return jsonChunks(value);
  return pieces;
}
