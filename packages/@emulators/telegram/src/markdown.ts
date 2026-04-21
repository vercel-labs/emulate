import type { MessageEntity } from "./entities.js";

/**
 * MarkdownV2 parser. Extracts entities from marked-up text and returns the
 * stripped plain text alongside the entity array.
 *
 * Matches real Telegram's behaviour on the happy path and on the common
 * failure modes:
 *
 * - Reserved characters that must be escaped with `\` anywhere outside a
 *   valid marker: `_ * [ ] ( ) ~ ` > # + - = | { } . !`
 *   Unescaped appearance outside a matching entity marker triggers a 400
 *   error: "can't parse entities: character 'X' is reserved and must be
 *   escaped with the preceding '\'".
 * - Unbalanced markers (open `*` without a matching close) also trigger a
 *   "can't parse entities" error.
 * - Supported markers: `*bold*`, `_italic_`, `__underline__`,
 *   `~strikethrough~`, `||spoiler||`, `` `code` ``, ` ```pre``` `,
 *   `[text](url)` including `tg://user?id=N` for text_mentions.
 * - Any character can be escaped with `\`; the backslash is removed and
 *   the next character is emitted literally.
 *
 * Entity offsets and lengths are counted in UTF-16 code units to match the
 * Bot API (JavaScript's native `.length`).
 *
 * This parser is not a byte-for-byte clone of Telegram's parser — edge
 * cases around nested emphasis and tricky mixed-escape inputs may diverge.
 * The target is faithfulness for the inputs bots and SDKs actually
 * generate.
 */
export interface ParsedMarkup {
  text: string;
  entities: MessageEntity[];
}

export class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownParseError";
  }
}

const RESERVED = new Set("_*[]()~`>#+-=|{}.!".split(""));

type OpenEntity = {
  type: MessageEntity["type"];
  markerLen: number;
  startOffset: number; // offset in output text where entity begins
  extra?: Partial<MessageEntity>;
};

export function parseMarkdownV2(input: string): ParsedMarkup {
  const out: string[] = [];
  const entities: MessageEntity[] = [];
  const stack: OpenEntity[] = [];
  let i = 0;

  const pushEntity = (e: Omit<MessageEntity, "offset"> & { startOffset: number }) => {
    const endOffset = utf16Length(out.join(""));
    entities.push({
      type: e.type,
      offset: e.startOffset,
      length: endOffset - e.startOffset,
      ...(e.url ? { url: e.url } : {}),
      ...(e.user ? { user: e.user } : {}),
      ...(e.language ? { language: e.language } : {}),
    });
  };

  while (i < input.length) {
    const ch = input[i];

    // --- Blockquote (`>` at line start, consecutive `>`-prefixed lines).
    //     Expandable blockquote: leading `**>` on first line, trailing `||`
    //     on last line.
    const atLineStart = i === 0 || input[i - 1] === "\n";
    if (atLineStart) {
      const expandable = input.startsWith("**>", i);
      const plain = !expandable && ch === ">";
      if (expandable || plain) {
        const quote = parseBlockquote(input, i, expandable);
        if (quote) {
          const startOffset = utf16Length(out.join(""));
          const inner = parseMarkdownV2(quote.body);
          out.push(inner.text);
          for (const e of inner.entities) {
            entities.push({ ...e, offset: e.offset + startOffset });
          }
          entities.push({
            type: expandable ? "expandable_blockquote" : "blockquote",
            offset: startOffset,
            length: utf16Length(inner.text),
          });
          i = quote.nextIdx;
          continue;
        }
      }
    }

    if (ch === "\\") {
      // Escape: emit the next char literally, consume both.
      if (i + 1 >= input.length) {
        throw new MarkdownParseError(
          "Bad Request: can't parse entities: stray '\\' at end of input",
        );
      }
      out.push(input[i + 1]);
      i += 2;
      continue;
    }

    // --- Code blocks ``` ---
    if (input.startsWith("```", i)) {
      // Find a closing ``` that is not escaped.
      const closeStart = findUnescaped(input, "```", i + 3);
      if (closeStart === -1) {
        throw new MarkdownParseError(
          "Bad Request: can't parse entities: unclosed code block",
        );
      }
      let body = input.slice(i + 3, closeStart);
      // Optional language line: first line before newline.
      let language: string | undefined;
      const nl = body.indexOf("\n");
      if (nl >= 0) {
        const maybeLang = body.slice(0, nl).trim();
        if (maybeLang && /^[A-Za-z][A-Za-z0-9_+-]*$/.test(maybeLang)) {
          language = maybeLang;
          body = body.slice(nl + 1);
        }
      }
      // Unescape \` and \\ inside pre blocks (real Telegram requires them
      // to be escaped; the emitted text is the unescaped form).
      body = body.replace(/\\([`\\])/g, "$1");
      const startOffset = utf16Length(out.join(""));
      out.push(body);
      entities.push({
        type: "pre",
        offset: startOffset,
        length: utf16Length(body),
        ...(language ? { language } : {}),
      });
      i = closeStart + 3;
      continue;
    }

    // --- Inline code ` ---
    if (ch === "`") {
      const closeIdx = findUnescaped(input, "`", i + 1);
      if (closeIdx === -1) {
        throw new MarkdownParseError(
          "Bad Request: can't parse entities: unclosed inline code",
        );
      }
      const raw = input.slice(i + 1, closeIdx);
      const body = raw.replace(/\\([`\\])/g, "$1");
      const startOffset = utf16Length(out.join(""));
      out.push(body);
      entities.push({ type: "code", offset: startOffset, length: utf16Length(body) });
      i = closeIdx + 1;
      continue;
    }

    // --- Inline link [text](url) ---
    if (ch === "[") {
      const parsed = parseLink(input, i);
      if (!parsed) {
        throw new MarkdownParseError(
          "Bad Request: can't parse entities: malformed or unclosed inline link",
        );
      }
      const { text: linkText, url, nextIdx } = parsed;
      const inner = parseMarkdownV2(linkText); // recursive for styled link text
      const startOffset = utf16Length(out.join(""));
      out.push(inner.text);
      // Shift inner entities by startOffset and keep them
      for (const e of inner.entities) {
        entities.push({ ...e, offset: e.offset + startOffset });
      }
      if (url.startsWith("tg://user?id=")) {
        const uid = Number(url.slice("tg://user?id=".length));
        if (Number.isFinite(uid)) {
          entities.push({
            type: "text_mention",
            offset: startOffset,
            length: utf16Length(inner.text),
            user: { id: uid, is_bot: false, first_name: "" },
          });
        }
      } else {
        entities.push({
          type: "text_link",
          offset: startOffset,
          length: utf16Length(inner.text),
          url,
        });
      }
      i = nextIdx;
      continue;
    }

    // --- Two-char markers (check before single) ---
    if (input.startsWith("__", i) && input[i + 2] !== "_") {
      toggleEntity(stack, "underline", 2, out, i, input, entities);
      i += 2;
      continue;
    }
    if (input.startsWith("||", i)) {
      toggleEntity(stack, "spoiler", 2, out, i, input, entities);
      i += 2;
      continue;
    }

    // --- Single-char markers ---
    if (ch === "*") {
      toggleEntity(stack, "bold", 1, out, i, input, entities);
      i += 1;
      continue;
    }
    if (ch === "_") {
      toggleEntity(stack, "italic", 1, out, i, input, entities);
      i += 1;
      continue;
    }
    if (ch === "~") {
      toggleEntity(stack, "strikethrough", 1, out, i, input, entities);
      i += 1;
      continue;
    }

    // --- Reserved character check ---
    if (RESERVED.has(ch)) {
      throw new MarkdownParseError(
        `Bad Request: can't parse entities: character '${ch}' is reserved and must be escaped with the preceding '\\'`,
      );
    }

    out.push(ch);
    i += 1;
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new MarkdownParseError(
      `Bad Request: can't parse entities: unclosed entity of type ${open.type}`,
    );
  }

  // Sort entities by (offset, length desc) so the order is deterministic —
  // real Telegram groups them by offset ascending.
  entities.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));

  return { text: out.join(""), entities };
}

function toggleEntity(
  stack: OpenEntity[],
  type: MessageEntity["type"],
  markerLen: number,
  out: string[],
  inputIdx: number,
  input: string,
  entities: MessageEntity[],
): void {
  void inputIdx;
  void input;
  const currentOffset = utf16Length(out.join(""));
  const topIdx = stack.findIndex((e) => e.type === type);
  if (topIdx === -1) {
    // Open a new entity of this type.
    stack.push({ type, markerLen, startOffset: currentOffset });
    return;
  }
  // Close: pop the top-most entity of this type (simple model; real
  // Telegram enforces strict nesting).
  const open = stack.splice(topIdx, 1)[0];
  entities.push({
    type: open.type,
    offset: open.startOffset,
    length: currentOffset - open.startOffset,
  });
}

function parseLink(
  input: string,
  start: number,
): { text: string; url: string; nextIdx: number } | null {
  // Find matching `]` without traversing into nested `[` or escapes.
  let i = start + 1;
  let text = "";
  while (i < input.length) {
    const c = input[i];
    if (c === "\\" && i + 1 < input.length) {
      text += input[i + 1];
      i += 2;
      continue;
    }
    if (c === "]") break;
    if (c === "\n") return null;
    text += c;
    i += 1;
  }
  if (i >= input.length || input[i] !== "]") return null;
  if (input[i + 1] !== "(") return null;
  // Parse URL inside (...) — backslash-escapes allowed.
  let j = i + 2;
  let url = "";
  while (j < input.length) {
    const c = input[j];
    if (c === "\\" && j + 1 < input.length) {
      url += input[j + 1];
      j += 2;
      continue;
    }
    if (c === ")") break;
    if (c === "\n") return null;
    url += c;
    j += 1;
  }
  if (j >= input.length || input[j] !== ")") return null;
  if (url.length === 0) return null;
  return { text, url, nextIdx: j + 1 };
}

function parseBlockquote(
  input: string,
  start: number,
  expandable: boolean,
): { body: string; nextIdx: number } | null {
  // Strip the leading `**` for expandable; each line must start with `>`.
  let i = expandable ? start + 2 : start;
  if (input[i] !== ">") return null;
  const lines: string[] = [];
  while (i < input.length) {
    if (input[i] !== ">") break;
    i += 1; // consume the leading `>`
    let line = "";
    while (i < input.length && input[i] !== "\n") {
      line += input[i];
      i += 1;
    }
    lines.push(line);
    if (i < input.length && input[i] === "\n") {
      i += 1; // consume the newline; the next iter checks if the new line starts with `>`
    }
  }
  if (lines.length === 0) return null;
  let nextIdx = i;
  if (expandable) {
    // The closing `||` must sit at the end of the last line content.
    const last = lines[lines.length - 1];
    if (!last.endsWith("||")) return null;
    lines[lines.length - 1] = last.slice(0, -2);
  }
  const body = lines.join("\n");
  return { body, nextIdx };
}

function findUnescaped(input: string, needle: string, startIdx: number): number {
  for (let i = startIdx; i <= input.length - needle.length; i++) {
    if (input[i] === "\\") {
      i += 1;
      continue;
    }
    if (input.startsWith(needle, i)) return i;
  }
  return -1;
}

function utf16Length(s: string): number {
  return s.length;
}
