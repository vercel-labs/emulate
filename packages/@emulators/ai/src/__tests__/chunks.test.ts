import { describe, expect, it } from "vitest";
import { jsonChunks, payloadChunks, textChunks } from "../chunks.js";

const structural = new Set([",", ":", "{", "[", "}", "]"]);

function insideString(value: string, position: number): boolean {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < position; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    }
  }
  return inString;
}

function splitOffsets(pieces: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const piece of pieces.slice(0, -1)) {
    offset += piece.length;
    offsets.push(offset);
  }
  return offsets;
}

describe("textChunks", () => {
  it("returns no pieces for empty text", () => {
    expect(textChunks("")).toEqual([]);
  });

  it("splits on word boundaries and keeps trailing whitespace with the word", () => {
    expect(textChunks("Hello brave world")).toEqual(["Hello ", "brave ", "world"]);
  });

  it("keeps whitespace runs with the word before them", () => {
    expect(textChunks("a  b\n\tc")).toEqual(["a  ", "b\n\t", "c"]);
    expect(textChunks("one\ntwo\tthree")).toEqual(["one\n", "two\t", "three"]);
  });

  it("keeps leading whitespace on the first piece", () => {
    expect(textChunks("  hi there")).toEqual(["  hi ", "there"]);
  });

  it("returns whitespace-only text as one piece", () => {
    expect(textChunks("   ")).toEqual(["   "]);
    expect(textChunks("\n\t ")).toEqual(["\n\t "]);
  });

  it("keeps a single word whole", () => {
    expect(textChunks("supercalifragilistic")).toEqual(["supercalifragilistic"]);
  });

  it("joins back to the original and never breaks inside a word", () => {
    const values = [
      "word",
      "Hello brave world",
      "  leading whitespace",
      "trailing whitespace  ",
      "a  b   c",
      "one\ntwo\tthree",
      "emoji check ✓ and punctuation, here.",
      " ".repeat(64),
    ];

    for (const value of values) {
      const pieces = textChunks(value);
      expect(pieces.join("")).toBe(value);
      expect(pieces.every((piece) => piece.length > 0)).toBe(true);
      for (const piece of pieces) {
        expect(/\s/.test(piece.trim())).toBe(false);
      }
    }
  });
});

describe("jsonChunks", () => {
  it("returns no pieces for empty text", () => {
    expect(jsonChunks("")).toEqual([]);
  });

  it("splits compact JSON between structural characters", () => {
    const value = '{"alpha":1,"beta":2}';

    expect(jsonChunks(value)).toEqual(['{"alpha":', '1,"beta":', "2}"]);
    expect(jsonChunks(value).join("")).toBe(value);
  });

  it("keeps short JSON as one piece", () => {
    expect(jsonChunks("{}")).toEqual(["{}"]);
    expect(jsonChunks("[]")).toEqual(["[]"]);
  });

  it("never splits inside a string, including escaped quotes and backslashes", () => {
    const values = [
      JSON.stringify({ alpha: 1, beta: 2, gamma: 3 }),
      JSON.stringify({ text: 'she said "hi" and left', path: "C:\\temp\\x", list: [1, 2, 3, 4, 5, 6, 7, 8] }),
      JSON.stringify([{ id: "a", tags: ["x", "y"], nested: { ok: true, note: "a,b:c {d} [e]" } }]),
      JSON.stringify({ unicode: "café ünïcode ✓", digits: "0123456789" }),
    ];

    for (const value of values) {
      const pieces = jsonChunks(value);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.join("")).toBe(value);
      expect(pieces.every((piece) => piece.length > 0)).toBe(true);

      for (const offset of splitOffsets(pieces)) {
        expect(insideString(value, offset)).toBe(false);
      }
    }
  });

  it("ends every piece but the last on a structural character", () => {
    const value = JSON.stringify({ alpha: 1, beta: [2, 3], gamma: { note: "a,b:c {d} [e]" } });
    const pieces = jsonChunks(value);

    expect(pieces.length).toBeGreaterThan(1);
    for (const offset of splitOffsets(pieces)) {
      expect(structural.has(value[offset - 1])).toBe(true);
    }
  });

  it("keeps escaped quotes inside the string they belong to", () => {
    const value = JSON.stringify({ quoted: 'a "quoted" value', other: "x", spare: "0123456789" });
    const pieces = jsonChunks(value);

    expect(pieces.join("")).toBe(value);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith('"')).toBe(false);
      expect(piece.endsWith("\\")).toBe(false);
    }
  });
});

describe("payloadChunks", () => {
  it("splits prose on word boundaries", () => {
    const value = "A short reply about nothing in particular";

    expect(payloadChunks(value)).toEqual(textChunks(value));
  });

  it("splits a single compact JSON reply as JSON", () => {
    const value = '{"alpha":1,"beta":[2,3],"gamma":"a,b:c[d]"}';

    expect(payloadChunks(value)).toEqual(jsonChunks(value));
    expect(payloadChunks(value).join("")).toBe(value);
  });
});
